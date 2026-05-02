function _ts_decorate(decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for(var i = decorators.length - 1; i >= 0; i--)if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
}
function _ts_metadata(k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
}
import { Injectable, Logger } from "@nestjs/common";
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import { DKAuthService } from "./dk-auth.service.js";
export class DKSignatureService {
    constructor(authService){
        this.authService = authService;
        this.logger = new Logger(DKSignatureService.name);
    }
    async generateSignedHeaders(requestBody) {
        try {
            //   console.log("\n=== SIGNATURE GENERATION DEBUG ===");
            //   console.log(
            //     "1. Original request body:",
            //     JSON.stringify(requestBody, null, 2),
            //   );
            // Generate timestamp in ISO 8601 format (UTC) without milliseconds
            const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
            // Generate unique nonce
            const nonce = this.generateNonce();
            // Serialize request body to canonical JSON with sorted keys
            const sortedBody = this.sortObjectKeys(requestBody);
            //   console.log("2. Sorted body:", JSON.stringify(sortedBody, null, 2));
            // JSON.stringify without space parameter produces compact JSON (no spaces between keys/values)
            const requestBodyStr = JSON.stringify(sortedBody);
            //   console.log("3. Canonical JSON string:", requestBodyStr);
            //   console.log("4. JSON string length:", requestBodyStr.length);
            // Base64 encode the request body
            const bodyBase64 = Buffer.from(requestBodyStr).toString("base64");
            //   console.log("5. Base64 encoded:", bodyBase64);
            // Create JWT payload
            const payload = {
                data: bodyBase64,
                timestamp,
                nonce
            };
            //   console.log("6. JWT payload:", JSON.stringify(payload, null, 2));
            // Get RSA private key
            const privateKey = await this.authService.getPrivateKey();
            // Sign the payload with RS256
            const signature = jwt.sign(payload, privateKey, {
                algorithm: "RS256",
                noTimestamp: false
            });
            //   console.log(
            //     "7. Generated signature (first 50 chars):",
            //     signature.substring(0, 50),
            //   );
            //   console.log("=== END SIGNATURE DEBUG ===\n");
            //   this.logger.debug("Signature generated successfully");
            return {
                "DK-Signature": `DKSignature ${signature}`,
                "DK-Timestamp": timestamp,
                "DK-Nonce": nonce
            };
        } catch (error) {
            this.logger.error("Failed to generate signature", error);
            throw error;
        }
    }
    generateNonce() {
        return uuidv4().replaceAll("-", "");
    }
    // Sort object keys recursively for canonical JSON
    sortObjectKeys(obj) {
        if (Array.isArray(obj)) {
            return obj.map((item)=>this.sortObjectKeys(item));
        }
        if (obj !== null && typeof obj === "object") {
            return Object.keys(obj).sort().reduce((sorted, key)=>{
                sorted[key] = this.sortObjectKeys(obj[key]);
                return sorted;
            }, {});
        }
        return obj;
    }
}
DKSignatureService = _ts_decorate([
    Injectable(),
    _ts_metadata("design:type", Function),
    _ts_metadata("design:paramtypes", [
        typeof DKAuthService === "undefined" ? Object : DKAuthService
    ])
], DKSignatureService);

//# sourceMappingURL=dk-signature.service.js.map