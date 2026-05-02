function _ts_decorate(decorators, target, key, desc) {
  var c = arguments.length,
    r =
      c < 3
        ? target
        : desc === null
          ? (desc = Object.getOwnPropertyDescriptor(target, key))
          : desc,
    d;
  if (typeof Reflect === "object" && typeof Reflect.decorate === "function")
    r = Reflect.decorate(decorators, target, key, desc);
  else
    for (var i = decorators.length - 1; i >= 0; i--)
      if ((d = decorators[i]))
        r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
  return (c > 3 && r && Object.defineProperty(target, key, r), r);
}
function _ts_metadata(k, v) {
  if (typeof Reflect === "object" && typeof Reflect.metadata === "function")
    return Reflect.metadata(k, v);
}
import { Injectable, Logger } from "@nestjs/common";
import https from "https";
import { PaymentConfigService } from "../payment-config.service.js";

/** Zero-dependency HTTPS POST using Node.js built-in https module. */
function nativeFetch(baseUrl, path, body, headers, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const payload = typeof body === "string" ? body : JSON.stringify(body);
    const url = new URL(baseUrl + path);
    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        ...headers,
      },
      rejectUnauthorized: false, // DK staging uses self-signed cert (internal gateway only)
      timeout: timeoutMs,
    };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode}: ${text}`));
        }
        try {
          resolve(JSON.parse(text));
        } catch {
          resolve(text);
        }
      });
    });
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timed out"));
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

export class DKAuthService {
  constructor(configService) {
    this.configService = configService;
    this.logger = new Logger(DKAuthService.name);
    this.tokenCache = null;
    this.privateKeyCache = null;
    this.baseUrl = this.configService.baseUrl;
  }
  async getValidToken() {
    if (this.tokenCache && !this.isTokenExpiringSoon()) {
      return this.tokenCache.accessToken;
    }
    await this.refreshToken();
    // console.log(
    //   "Token refreshed in getValidToken",
    //   this.tokenCache!.accessToken,
    // );
    return this.tokenCache.accessToken;
  }
  async getPrivateKey() {
    if (this.privateKeyCache) {
      return this.privateKeyCache;
    }
    await this.fetchPrivateKey();
    // console.log(
    //   "Private key fetched in getPrivateKey",
    //   this.privateKeyCache!.slice(0, 10) + "...",
    // );
    return this.privateKeyCache;
  }
  async refreshToken() {
    try {
      //   this.logger.log("Fetching new authentication token...");
      //   console.log();
      const config = this.configService.getConfig();
      // Prepare form-urlencoded data
      const params = new URLSearchParams();
      params.append("username", config.username);
      params.append("password", config.password);
      params.append("client_id", config.clientId);
      params.append("client_secret", config.clientSecret);
      params.append("grant_type", "password");
      params.append("scopes", "keys:read");
      params.append("source_app", config.sourceApp);
      params.append("request_id", this.generateRequestId());
      const response = await nativeFetch(
        this.baseUrl,
        "/v1/auth/token",
        params.toString(),
        {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-gravitee-api-key": this.configService.apiKey,
        },
      );
      if (response.response_code !== "0000" || !response.response_data) {
        throw new Error(`Token fetch failed: ${response.response_description}`);
      }
      const tokenData = response.response_data;
      const expiresAt = new Date();
      expiresAt.setSeconds(expiresAt.getSeconds() + tokenData.expires_in);
      this.tokenCache = {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
        tokenType: tokenData.token_type,
        expiresIn: tokenData.expires_in,
        expiresAt,
      };
      this.logger.log("Authentication token fetched successfully");
      // ✅ LOGGING THE ACCESS TOKEN HERE
      this.logger.debug(
        `New Access Token received: ${this.tokenCache.accessToken.slice(0, 10)}... (Expires: ${this.tokenCache.expiresAt.toISOString()})`,
      );
    } catch (error) {
      this.logger.error("Failed to fetch authentication token", error);
      throw error;
    }
  }
  async fetchPrivateKey() {
    try {
      this.logger.log("Fetching RSA private key...");
      const token = await this.getValidToken();
      const response = await nativeFetch(
        this.baseUrl,
        "/v1/sign/key",
        JSON.stringify({
          request_id: this.generateRequestId(),
          source_app: this.configService.sourceApp,
        }),
        {
          Authorization: `Bearer ${token}`,
          "X-gravitee-api-key": this.configService.apiKey,
        },
      );
      if (
        typeof response === "string" &&
        response.includes("BEGIN PRIVATE KEY") &&
        response.includes("END PRIVATE KEY")
      ) {
        this.privateKeyCache = response;
        this.logger.log("RSA private key fetched successfully");
      } else if (typeof response === "object" && response !== null) {
        const errorData = response;
        const errorMessage =
          errorData.response_detail ||
          errorData.response_description ||
          "Unknown error";
        throw new Error(
          `Failed to fetch private key: ${errorMessage} (Code: ${errorData.response_code})`,
        );
      } else {
        throw new Error("Invalid RSA key response format");
      }
    } catch (error) {
      this.logger.error("Failed to fetch RSA private key", error);
      throw error;
    }
  }
  isTokenExpiringSoon() {
    if (!this.tokenCache) {
      return true;
    }
    // Refresh if token expires in less than 5 minutes
    const fiveMinutesFromNow = new Date();
    fiveMinutesFromNow.setMinutes(fiveMinutesFromNow.getMinutes() + 5);
    return this.tokenCache.expiresAt <= fiveMinutesFromNow;
  }
  generateRequestId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  }
  // For testing/admin purposes
  clearCache() {
    this.tokenCache = null;
    this.privateKeyCache = null;
    this.logger.log("Token and key cache cleared");
  }
}
DKAuthService = _ts_decorate(
  [
    Injectable(),
    _ts_metadata("design:type", Function),
    _ts_metadata("design:paramtypes", [
      typeof PaymentConfigService === "undefined"
        ? Object
        : PaymentConfigService,
    ]),
  ],
  DKAuthService,
);

//# sourceMappingURL=dk-auth.service.js.map
