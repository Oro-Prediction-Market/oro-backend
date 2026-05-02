function _ts_decorate(decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for(var i = decorators.length - 1; i >= 0; i--)if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
}
function _ts_metadata(k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
}
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
export class PaymentConfigService {
    constructor(configService){
        this.configService = configService;
    }
    getConfig() {
        return {
            baseUrl: this.configService.getOrThrow("DK_BASE_URL"),
            apiKey: this.configService.getOrThrow("DK_API_KEY"),
            username: this.configService.getOrThrow("DK_USERNAME"),
            password: this.configService.getOrThrow("DK_PASSWORD"),
            clientId: this.configService.getOrThrow("DK_CLIENT_ID"),
            clientSecret: this.configService.getOrThrow("DK_CLIENT_SECRET"),
            sourceApp: this.configService.getOrThrow("DK_SOURCE_APP"),
            beneficiaryAccount: this.configService.getOrThrow("DK_BENEFICIARY_ACCOUNT"),
            publicAccount: this.configService.getOrThrow("DK_PUBLIC_ACCOUNT_NO"),
            bankCode: this.configService.getOrThrow("DK_BANK_CODE"),
            beneficiaryName: this.configService.get("DK_BENEFICIARY_NAME") || "Lucky Pem"
        };
    }
    get baseUrl() {
        return this.getConfig().baseUrl;
    }
    get apiKey() {
        return this.getConfig().apiKey;
    }
    get username() {
        return this.getConfig().username;
    }
    get password() {
        return this.getConfig().password;
    }
    get clientId() {
        return this.getConfig().clientId;
    }
    get clientSecret() {
        return this.getConfig().clientSecret;
    }
    get sourceApp() {
        return this.getConfig().sourceApp;
    }
    get beneficiaryAccount() {
        return this.getConfig().beneficiaryAccount;
    }
    get publicAccount() {
        return this.getConfig().publicAccount;
    }
    get bankCode() {
        return this.getConfig().bankCode;
    }
}
PaymentConfigService = _ts_decorate([
    Injectable(),
    _ts_metadata("design:type", Function),
    _ts_metadata("design:paramtypes", [
        typeof ConfigService === "undefined" ? Object : ConfigService
    ])
], PaymentConfigService);

//# sourceMappingURL=payment-config.service.js.map