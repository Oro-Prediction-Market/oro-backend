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
import { AccountNotFoundException } from "../../exceptions/account-not-found.exception.js";
import { DKGatewayException } from "../../exceptions/dk-gateway.exception.js";
import { DKClientService } from "./dk-client.service.js";
export class DKAccountService {
    constructor(dkClient){
        this.dkClient = dkClient;
        this.logger = new Logger(DKAccountService.name);
    }
    async verifyAccountByCID(cid) {
        try {
            this.logger.log(`Verifying account for CID: ${cid}`);
            const request = {
                id_type: "CID",
                id_number: cid
            };
            const response = await this.dkClient.post(DK_API_ENDPOINTS.ACCOUNT.CLIENT_INQUIRY, request);
            if (response.response_code !== DK_RESPONSE_CODES.SUCCESS) {
                if (response.response_code === DK_RESPONSE_CODES.NOT_FOUND) {
                    throw new AccountNotFoundException(cid);
                }
                throw new DKGatewayException(response.response_code, response.response_description);
            }
            if (!response.response_data || response.response_data.length === 0) {
                throw new AccountNotFoundException(cid);
            }
            const accountInfo = response.response_data[0];
            // Now verify the account and get inquiry ID
            const accountDetails = await this.verifyAccount(accountInfo.account_number);
            return {
                ...accountDetails,
                cid
            };
        } catch (error) {
            this.logger.error(`Failed to verify account for CID: ${cid}`, error);
            throw error;
        }
    }
    async verifyAccount(accountNumber) {
        try {
            this.logger.log(`Performing account inquiry for: ${accountNumber}`);
            const request = {
                account_number: accountNumber
            };
            const response = await this.dkClient.post(DK_API_ENDPOINTS.ACCOUNT.INQUIRY, request);
            if (response.response_code !== DK_RESPONSE_CODES.SUCCESS) {
                if (response.response_code === DK_RESPONSE_CODES.NOT_FOUND) {
                    throw new AccountNotFoundException(accountNumber);
                }
                throw new DKGatewayException(response.response_code, response.response_description);
            }
            if (!response.response_data) {
                throw new AccountNotFoundException(accountNumber);
            }
            return {
                accountNumber: response.response_data.account_number,
                accountName: response.response_data.beneficiary_account_name,
                balance: response.response_data.balance_info,
                inquiryId: response.response_data.inquiry_id
            };
        } catch (error) {
            this.logger.error(`Failed to verify account: ${accountNumber}`, error);
            throw error;
        }
    }
    async verifyAccountByAccountNumber(accountNumber) {
        try {
            const accountDetails = await this.verifyAccount(accountNumber);
            return {
                ...accountDetails,
                hasAccount: true,
                cidNo: accountDetails.cid
            };
        } catch (error) {
            this.logger.warn(`Account not found for account number: ${accountNumber}`);
            return {
                accountNumber,
                accountName: "",
                balance: "BTN: 0.00",
                inquiryId: "",
                hasAccount: false,
                cidNo: ""
            };
        }
    }
    async clientInquiry(dto) {
        try {
            this.logger.log(`Performing client inquiry for ${dto.id_type}: ${dto.id_number}`);
            const request = {
                id_type: dto.id_type,
                id_number: dto.id_number
            };
            const response = await this.dkClient.post(DK_API_ENDPOINTS.ACCOUNT.CLIENT_INQUIRY, request);
            // Log the raw response from DK Gateway
            this.logger.log(`DK Gateway raw response: ${JSON.stringify(response, null, 2)}`);
            return response;
        } catch (error) {
            this.logger.error(`Failed client inquiry for ${dto.id_type}: ${dto.id_number}`, error);
            throw error;
        }
    }
}
DKAccountService = _ts_decorate([
    Injectable(),
    _ts_metadata("design:type", Function),
    _ts_metadata("design:paramtypes", [
        typeof DKClientService === "undefined" ? Object : DKClientService
    ])
], DKAccountService);

//# sourceMappingURL=dk-account.service.js.map