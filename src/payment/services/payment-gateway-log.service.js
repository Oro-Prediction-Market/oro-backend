function _ts_decorate(decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for(var i = decorators.length - 1; i >= 0; i--)if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
}
function _ts_metadata(k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
}
function _ts_param(paramIndex, decorator) {
    return function(target, key) {
        decorator(target, key, paramIndex);
    };
}
import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { PaymentGatewayLogEntity } from "../payment-gateway-log.entity.js";
export class PaymentGatewayLogService {
    constructor(gatewayLogRepository){
        this.gatewayLogRepository = gatewayLogRepository;
        this.logger = new Logger(PaymentGatewayLogService.name);
    }
    async logRequest(params) {
        try {
            const logEntry = this.gatewayLogRepository.create({
                endpoint: params.endpoint,
                method: params.method,
                requestBody: params.requestBody ? JSON.stringify(params.requestBody) : undefined,
                requestHeaders: params.requestHeaders ? JSON.stringify(params.requestHeaders) : undefined,
                responseBody: params.responseBody ? JSON.stringify(params.responseBody) : undefined,
                responseStatus: params.responseStatus,
                errorMessage: params.errorMessage,
                durationMs: params.durationMs,
                requestId: params.requestId
            });
            await this.gatewayLogRepository.save(logEntry);
        } catch (error) {
            // Don't throw error for logging failures, just log the error
            this.logger.error("Failed to log payment gateway request", error);
        }
    }
}
PaymentGatewayLogService = _ts_decorate([
    Injectable(),
    _ts_param(0, InjectRepository(PaymentGatewayLogEntity)),
    _ts_metadata("design:type", Function),
    _ts_metadata("design:paramtypes", [
        typeof Repository === "undefined" ? Object : Repository
    ])
], PaymentGatewayLogService);

//# sourceMappingURL=payment-gateway-log.service.js.map