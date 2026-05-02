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
import { DK_API_ENDPOINTS } from "./dk-api-endpoints.js";
import { DK_RESPONSE_CODES } from "./dk-response-codes.js";
import { DKClientService } from "./dk-client.service.js";
export class DKPaymentStatusService {
    constructor(dkClient){
        this.dkClient = dkClient;
        this.logger = new Logger(DKPaymentStatusService.name);
    }
    async verifyStatus(request) {
        try {
            this.logger.log(`📤 [DK-PAYMENT-STATUS] Endpoint: ${DK_API_ENDPOINTS.TRANSACTION.STATUS}`);
            this.logger.log(`📤 [DK-PAYMENT-STATUS] Request Body: ${JSON.stringify(request, null, 2)}`);
            // Use the status endpoint (/v1/transaction/status) with the new 3-parameter format
            const response = await this.dkClient.post(DK_API_ENDPOINTS.TRANSACTION.STATUS, request);
            this.logger.log(`📥 [DK-PAYMENT-STATUS] === RAW DK GATEWAY RESPONSE ===`);
            this.logger.log(`📥 [DK-PAYMENT-STATUS] Raw Response: ${JSON.stringify(response, null, 2)}`);
            this.logger.log(`📥 [DK-PAYMENT-STATUS] === END RAW RESPONSE ===`);
            if (response.response_code === DK_RESPONSE_CODES.SUCCESS) {
                this.logger.log(`✅ [DK-PAYMENT-STATUS] Payment status verification successful for transaction: ${request.transaction_id}`);
            } else {
                this.logger.warn(`⚠️ [DK-PAYMENT-STATUS] Payment status verification returned non-success code: ${response.response_code} - ${response.response_description}`);
            }
            return response;
        } catch (error) {
            this.logger.error(`❌ [DK-PAYMENT-STATUS] Failed to verify payment status for transaction: ${request.transaction_id}`, error);
            // Return a generic error response in case of exceptions
            return {
                response_code: "5001",
                response_status: "Exception",
                response_description: "Exception occurred while checking payment status",
                meta_info: null,
                status: null,
                response_data: null
            };
        }
    }
}
DKPaymentStatusService = _ts_decorate([
    Injectable(),
    _ts_metadata("design:type", Function),
    _ts_metadata("design:paramtypes", [
        typeof DKClientService === "undefined" ? Object : DKClientService
    ])
], DKPaymentStatusService);

//# sourceMappingURL=dk-payment-status.service.js.map