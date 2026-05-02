export const DK_RESPONSE_CODES = {
    SUCCESS: "0000",
    TIMEOUT: "2002",
    INTERNAL_FAILURE: "2004",
    RESTRICTION: "2008",
    NOT_FOUND: "3001",
    INVALID_PARAMS: "4002",
    EXCEPTION: "5001",
    DB_ERROR: "5002",
    INTERNAL_NO_RESPONSE: "2001"
};
export const DK_RESPONSE_MESSAGES = {
    [DK_RESPONSE_CODES.SUCCESS]: "Transaction successful",
    [DK_RESPONSE_CODES.TIMEOUT]: "Request timeout - no response from third party",
    [DK_RESPONSE_CODES.INTERNAL_FAILURE]: "Internal host not found",
    [DK_RESPONSE_CODES.RESTRICTION]: "Transaction restriction in place",
    [DK_RESPONSE_CODES.NOT_FOUND]: "Record not found",
    [DK_RESPONSE_CODES.INVALID_PARAMS]: "Invalid parameter value",
    [DK_RESPONSE_CODES.EXCEPTION]: "Exception in code",
    [DK_RESPONSE_CODES.DB_ERROR]: "Exception in DB operation",
    [DK_RESPONSE_CODES.INTERNAL_NO_RESPONSE]: "No response from internal channels"
};
export const RETRYABLE_CODES = [
    DK_RESPONSE_CODES.TIMEOUT,
    DK_RESPONSE_CODES.DB_ERROR
];

//# sourceMappingURL=dk-response-codes.js.map