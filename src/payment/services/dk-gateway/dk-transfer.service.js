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
import { DKGatewayException } from "../../exceptions/dk-gateway.exception.js";
import { PaymentFailedException } from "../../exceptions/payment-failed.exception.js";
import { TransactionRestrictionException } from "../../exceptions/transaction-restriction.exception.js";
import { PaymentConfigService } from "../payment-config.service.js";
import { DK_API_ENDPOINTS } from "./dk-api-endpoints.js";
import { DKClientService } from "./dk-client.service.js";
import { DK_RESPONSE_CODES } from "./dk-response-codes.js";
export class DKTransferService {
    constructor(dkClient, configService){
        this.dkClient = dkClient;
        this.configService = configService;
        this.logger = new Logger(DKTransferService.name);
    }
    async initiatePayment(params) {
        try {
            this.logger.log(`Initiating payment: ${params.amount} BTN from ${params.sourceAccountNumber}`);
            const request = {
                inquiry_id: params.inquiryId,
                transaction_datetime: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
                source_app: this.configService.sourceApp,
                transaction_amount: params.amount.toFixed(2),
                currency: "BTN",
                payment_type: "INTRA",
                source_account_name: params.sourceAccountName,
                source_account_number: params.sourceAccountNumber,
                bene_cust_name: "National Day Lottery",
                bene_account_number: this.configService.beneficiaryAccount,
                bene_bank_code: this.configService.bankCode,
                narration: params.description
            };
            const response = await this.dkClient.post(DK_API_ENDPOINTS.TRANSACTION.INITIATE, request);
            if (response.response_code !== DK_RESPONSE_CODES.SUCCESS) {
                this.logger.error(response);
                // Special handling for code 2008: Transaction restriction
                if (response.response_code === "2008") {
                    throw new TransactionRestrictionException(response.response_description || "Payment declined due to transaction restrictions on your bank account.");
                }
                throw new DKGatewayException(response.response_code, response.response_message || "Transaction failed", response.response_description);
            }
            if (!response.response_data) {
                throw new PaymentFailedException("No transaction data returned");
            }
            this.logger.log(`Payment initiated successfully. TxnStatusId: ${response.response_data.txn_status_id}`);
            return {
                inquiryId: response.response_data.inquiry_id,
                txnStatusId: response.response_data.txn_status_id
            };
        } catch (error) {
            this.logger.error("Failed to initiate payment", error);
            throw error;
        }
    }
    async initiateRefund(params) {
        try {
            this.logger.log(`Initiating refund: ${params.amount} BTN to ${params.targetAccountNumber} (CID: ${params.targetCid})`);
            // First, get account inquiry for the target account
            const accountInquiryRequest = {
                account_number: params.targetAccountNumber
            };
            const inquiryResponse = await this.dkClient.post(DK_API_ENDPOINTS.ACCOUNT.INQUIRY, accountInquiryRequest);
            if (inquiryResponse.response_code !== DK_RESPONSE_CODES.SUCCESS) {
                throw new DKGatewayException(inquiryResponse.response_code, inquiryResponse.response_message || "Account inquiry failed", inquiryResponse.response_description);
            }
            const inquiryId = inquiryResponse.response_data.inquiry_id;
            // Now initiate the refund transfer FROM public account TO user account
            const refundRequest = {
                inquiry_id: inquiryId,
                transaction_datetime: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
                source_app: this.configService.sourceApp,
                transaction_amount: params.amount.toFixed(2),
                currency: "BTN",
                payment_type: "INTRA",
                source_account_name: "National Day Lottery",
                source_account_number: this.configService.publicAccount,
                bene_cust_name: params.targetAccountName,
                bene_account_number: params.targetAccountNumber,
                bene_bank_code: this.configService.bankCode,
                narration: params.description
            };
            const response = await this.dkClient.post(DK_API_ENDPOINTS.TRANSACTION.INITIATE, refundRequest);
            if (response.response_code !== DK_RESPONSE_CODES.SUCCESS) {
                throw new DKGatewayException(response.response_code, response.response_message || "Refund failed", response.response_description);
            }
            if (!response.response_data) {
                throw new PaymentFailedException("No refund transaction data returned");
            }
            this.logger.log(`Refund initiated successfully. TxnStatusId: ${response.response_data.txn_status_id}`);
            return {
                inquiryId: response.response_data.inquiry_id,
                txnStatusId: response.response_data.txn_status_id
            };
        } catch (error) {
            this.logger.error("Failed to initiate refund", error);
            throw error;
        }
    }
    async checkPaymentStatus(transactionId) {
        try {
            this.logger.log(`Checking payment status for: ${transactionId}`);
            const request = {
                transaction_id: transactionId,
                bene_account_number: this.configService.beneficiaryAccount
            };
            const response = await this.dkClient.post(DK_API_ENDPOINTS.TRANSACTION.STATUS, request);
            if (response.response_code !== DK_RESPONSE_CODES.SUCCESS) {
                if (response.response_code === DK_RESPONSE_CODES.NOT_FOUND) {
                    return {
                        status: "PENDING",
                        statusDescription: "Transaction not found - may be processed on next business day"
                    };
                }
                throw new DKGatewayException(response.response_code, response.response_message || "Transaction status check failed", response.response_description || "Unknown error");
            }
            if (!response.response_data) {
                return {
                    status: "PENDING",
                    statusDescription: "Transaction status not available"
                };
            }
            const statusData = response.response_data.status;
            return {
                status: statusData.status,
                statusDescription: statusData.status_desc,
                amount: statusData.amount,
                debitAccount: statusData.debit_account,
                creditAccount: statusData.credit_account,
                txnTimestamp: statusData.txn_ts
            };
        } catch (error) {
            this.logger.error(`Failed to check payment status for: ${transactionId}`, error);
            throw error;
        }
    }
}
DKTransferService = _ts_decorate([
    Injectable(),
    _ts_metadata("design:type", Function),
    _ts_metadata("design:paramtypes", [
        typeof DKClientService === "undefined" ? Object : DKClientService,
        typeof PaymentConfigService === "undefined" ? Object : PaymentConfigService
    ])
], DKTransferService);

//# sourceMappingURL=dk-transfer.service.js.map