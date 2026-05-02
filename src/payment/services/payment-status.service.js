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
import { DKPaymentStatusService } from "./dk-gateway/dk-payment-status.service.js";
export class PaymentStatusService {
    constructor(dkPaymentStatusService){
        this.dkPaymentStatusService = dkPaymentStatusService;
        this.logger = new Logger(PaymentStatusService.name);
    }
    async verifyPaymentStatus(dto) {
        try {
            this.logger.log(`🔍 [PAYMENT-STATUS] Verifying payment status with provided parameters:`);
            this.logger.log(`📋 [PAYMENT-STATUS] Transaction ID: ${dto.transaction_id}`);
            this.logger.log(`📋 [PAYMENT-STATUS] Request ID: ${dto.request_id}`);
            this.logger.log(`📋 [PAYMENT-STATUS] Beneficiary Account: ${dto.bene_account_number}`);
            // Validate required fields
            if (!dto.transaction_id) {
                return {
                    account_number: dto.bene_account_number,
                    transaction_id: "",
                    request_id: dto.request_id,
                    bene_account_number: dto.bene_account_number,
                    status_code: "3001",
                    status_message: "Missing",
                    status_description: "Transaction ID is required"
                };
            }
            if (!dto.request_id) {
                return {
                    account_number: dto.bene_account_number,
                    transaction_id: dto.transaction_id,
                    request_id: "",
                    bene_account_number: dto.bene_account_number,
                    status_code: "3001",
                    status_message: "Missing",
                    status_description: "Request ID is required"
                };
            }
            if (!dto.bene_account_number) {
                return {
                    account_number: dto.bene_account_number || "",
                    transaction_id: dto.transaction_id,
                    request_id: dto.request_id,
                    bene_account_number: "",
                    status_code: "3001",
                    status_message: "Missing",
                    status_description: "Beneficiary account number is required"
                };
            }
            // Call DK Gateway to verify payment status
            this.logger.log(`🚀 [PAYMENT-STATUS] Calling DK Gateway for payment status verification...`);
            const statusResponse = await this.dkPaymentStatusService.verifyStatus({
                request_id: dto.request_id,
                transaction_id: dto.transaction_id,
                bene_account_number: dto.bene_account_number
            });
            this.logger.log(`📨 [PAYMENT-STATUS] Received response from DK Gateway service`);
            // Build response based on DK Gateway response
            const response = {
                account_number: dto.bene_account_number,
                transaction_id: dto.transaction_id,
                request_id: dto.request_id,
                bene_account_number: dto.bene_account_number,
                status_code: statusResponse.response_code,
                status_message: statusResponse.response_status || "Unknown",
                status_description: statusResponse.response_description
            };
            // Handle success response
            if (statusResponse.response_code === "0000") {
                if (statusResponse.response_data && statusResponse.response_data.length > 0) {
                    const statusData = statusResponse.response_data[0];
                    if (statusData) {
                        response.payment_status = statusData.status;
                        response.payment_status_desc = statusData.status_desc;
                        response.amount = statusData.amount;
                        response.debit_account = statusData.debit_account;
                        response.credit_account = statusData.credit_account;
                        response.transaction_timestamp = statusData.txn_ts;
                    }
                } else if (statusResponse.status) {
                    // Single status object (current day verification)
                    response.payment_status = statusResponse.status.status;
                    response.payment_status_desc = statusResponse.status.status_desc;
                    response.amount = statusResponse.status.amount;
                    response.debit_account = statusResponse.status.debit_account;
                    response.credit_account = statusResponse.status.credit_account;
                    response.transaction_timestamp = statusResponse.status.txn_ts;
                }
            }
            this.logger.log(`✅ [PAYMENT-STATUS] Payment status verification completed for account ${dto.bene_account_number}`);
            this.logger.log(`📤 [PAYMENT-STATUS] Final response being sent to client: ${JSON.stringify(response, null, 2)}`);
            return response;
        } catch (error) {
            this.logger.error(`Failed to verify payment status for account: ${dto.bene_account_number}`, error);
            return {
                account_number: dto.bene_account_number,
                transaction_id: "",
                request_id: "",
                bene_account_number: dto.bene_account_number,
                status_code: "5001",
                status_message: "Exception",
                status_description: "Internal server error occurred during verification"
            };
        }
    }
}
PaymentStatusService = _ts_decorate([
    Injectable(),
    _ts_metadata("design:type", Function),
    _ts_metadata("design:paramtypes", [
        typeof DKPaymentStatusService === "undefined" ? Object : DKPaymentStatusService
    ])
], PaymentStatusService);

//# sourceMappingURL=payment-status.service.js.map