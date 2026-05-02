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
import { Injectable, Logger, BadRequestException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { OtpEntity } from "../otp.entity.js";
import { NotificationService } from "../../../shared/services/notification.service.js";
export class OtpService {
    constructor(otpRepository, notificationService){
        this.otpRepository = otpRepository;
        this.notificationService = notificationService;
        this.logger = new Logger(OtpService.name);
    }
    /**
   * Generate and send OTP for a user (not tied to a specific transaction)
   */ async generateAndSendOTPForUser(user, purpose = "payment_verification", authToken) {
        try {
            // Invalidate any existing OTPs for this user
            await this.invalidateExistingOTPsForUser(user.id);
            // Generate new OTP
            const otpCode = this.generateOTPCode();
            const expiresAt = new Date(Date.now() + 2 * 60 * 1000); // 2 minutes
            // Create OTP entity (without transactionId)
            const otp = this.otpRepository.create({
                code: otpCode,
                expiresAt,
                purpose,
                userId: user.id,
                isUsed: false,
                isVerified: false,
                attemptCount: 0
            });
            // Save to database
            const savedOtp = await this.otpRepository.save(otp);
            // Send notifications (fire-and-forget)
            this.sendOTPNotifications(user, otpCode, authToken).catch((error)=>{
                this.logger.error(`Failed to send OTP notifications for user ${user.externalUserId}:`, error);
            });
            this.logger.log(`OTP generated for user: ${user.externalUserId}`);
            return savedOtp;
        } catch (error) {
            this.logger.error("Failed to generate and send OTP for user:", error);
            throw new BadRequestException("Failed to generate OTP");
        }
    }
    /**
   * Generate and send OTP for payment verification
   */ async generateAndSendOTP(user, transaction, purpose = "payment_verification", authToken) {
        try {
            // Invalidate any existing OTPs for this user
            await this.invalidateExistingOTPsForUser(user.id);
            // Generate new OTP
            const otpCode = this.generateOTPCode();
            const expiresAt = new Date(Date.now() + 2 * 60 * 1000); // 2 minutes
            // Create OTP entity
            const otp = this.otpRepository.create({
                code: otpCode,
                expiresAt,
                purpose,
                userId: user.id,
                isUsed: false,
                isVerified: false,
                attemptCount: 0
            });
            // Save to database
            const savedOtp = await this.otpRepository.save(otp);
            // Send notifications (fire-and-forget)
            this.sendOTPNotifications(user, otpCode, authToken).catch((error)=>{
                this.logger.error(`Failed to send OTP notifications for transaction ${transaction.id}:`, error);
            });
            this.logger.log(`OTP generated for transaction ${transaction.id}, User: ${user.externalUserId}`);
            return savedOtp;
        } catch (error) {
            this.logger.error("Failed to generate and send OTP:", error);
            throw new BadRequestException("Failed to generate OTP");
        }
    }
    /**
   * Verify OTP code by userId (for user-based OTP verification)
   */ async verifyOTPByUserId(userId, otpCode) {
        try {
            // Find the most recent valid OTP for this user
            const otp = await this.otpRepository.findOne({
                where: {
                    userId,
                    code: otpCode,
                    isUsed: false
                },
                order: {
                    createdAt: "DESC"
                }
            });
            if (!otp) {
                this.logger.warn(`Invalid OTP attempt for user ${userId}`);
                return {
                    success: false,
                    error: "invalid OTP",
                    errorCode: "5001"
                };
            }
            // Increment attempt count
            otp.attemptCount += 1;
            await this.otpRepository.save(otp);
            // Check if OTP can be verified
            if (!otp.canBeVerified()) {
                if (otp.isExpired()) {
                    return {
                        success: false,
                        error: "OTP time expired",
                        errorCode: "5002"
                    };
                }
                if (otp.isUsed) {
                    return {
                        success: false,
                        error: "OTP has already been used",
                        errorCode: "5003"
                    };
                }
                if (otp.attemptCount >= 3) {
                    return {
                        success: false,
                        error: "Too many invalid attempts",
                        errorCode: "5004"
                    };
                }
                return {
                    success: false,
                    error: "invalid OTP",
                    errorCode: "5001"
                };
            }
            // Mark as verified and used
            otp.isVerified = true;
            otp.isUsed = true;
            otp.verifiedAt = new Date();
            await this.otpRepository.save(otp);
            this.logger.log(`OTP verified successfully for user ${userId}`);
            return {
                success: true
            };
        } catch (error) {
            this.logger.error("Failed to verify OTP by userId:", error);
            return {
                success: false,
                error: "Failed to verify OTP",
                errorCode: "5000"
            };
        }
    }
    /**
   * Invalidate existing OTPs for a user
   */ async invalidateExistingOTPsForUser(userId) {
        await this.otpRepository.update({
            userId,
            isUsed: false
        }, {
            isUsed: true
        });
    }
    /**
   * Generate 6-digit OTP code
   */ generateOTPCode() {
        return Math.floor(100000 + Math.random() * 900000).toString();
    }
    /**
   * Format phone number with + prefix
   */ formatPhoneNumber(phoneNumber) {
        if (!phoneNumber) return "";
        // Remove any existing country code
        let cleanNumber = phoneNumber.replace(/^\+/, "");
        // Remove any non-digit characters
        cleanNumber = cleanNumber.replace(/\D/g, "");
        // Add + prefix
        return `+${cleanNumber}`;
    }
    /**
   * Send OTP via both push notification and SMS
   */ async sendOTPNotifications(user, otpCode, authToken) {
        try {
            const externalPhoneNumber = user.externalPhoneNumber;
            if (externalPhoneNumber) {
                const formattedPhone = this.formatPhoneNumber(externalPhoneNumber);
                // Send both push notification and SMS using the passed auth token
                await this.notificationService.sendOTPViaBothChannels(user.externalUserId, formattedPhone, otpCode, 2, authToken);
                this.logger.log(`OTP notifications sent - User: ${user.externalUserId}, Phone: ${formattedPhone}`);
            } else {
                this.logger.warn(`No external phone number found for user ${user.id}, skipping SMS notification`);
                // Send only push notification using the passed auth token
                await this.notificationService.sendOTPNotification(user.externalUserId, otpCode, 2, authToken);
            }
        } catch (error) {
            this.logger.error("Failed to send OTP notifications:", error);
        // Don't throw error - notifications are fire-and-forget
        }
    }
}
OtpService = _ts_decorate([
    Injectable(),
    _ts_param(0, InjectRepository(OtpEntity)),
    _ts_metadata("design:type", Function),
    _ts_metadata("design:paramtypes", [
        typeof Repository === "undefined" ? Object : Repository,
        typeof NotificationService === "undefined" ? Object : NotificationService
    ])
], OtpService);

//# sourceMappingURL=otp.service.js.map