# Client Inquiry API Implementation

## Overview

A new endpoint has been created to retrieve complete customer details and all associated DK Bank accounts using a CID (Citizenship ID).

## API Endpoint

### POST `/api/payments/client-inquiry`

**Authentication:** Public (no authentication required)

**Description:** Retrieves complete customer information including name, country, phone number, and all linked DK Bank accounts.

## Request

### Request Body

```json
{
  "id_type": "CID",
  "id_number": "10705001283"
}
```

### Field Validation

- `id_type`: Must be "CID" (enum)
- `id_number`: Must be exactly 11 characters (CID format)

## Response

### Success Response (200 OK)

```json
{
  "response_code": "0000",
  "response_message": "Success",
  "response_description": "Record of Customer Details",
  "response_data": [
    {
      "national_id": "10705001283",
      "account_number": "100100366202",
      "citizen_country": "Bhutan",
      "first_name": "Sangay",
      "middle_name": null,
      "last_name": "Wangdi",
      "phone_number": "17123456"
    }
  ]
}
```

### Not Found Response (200 OK with error code)

```json
{
  "response_code": "3001",
  "response_message": "Missing",
  "response_description": "Missing record/record not found",
  "response_data": []
}
```

### Bad Request Response (400)

```json
{
  "message": ["id_number must be exactly 11 characters"],
  "error": "Bad Request",
  "statusCode": 400
}
```

## Response Fields

| Field                  | Type   | Description              | Example                      |
| ---------------------- | ------ | ------------------------ | ---------------------------- |
| `response_code`        | string | DK Gateway response code | "0000"                       |
| `response_message`     | string | Response message         | "Success"                    |
| `response_description` | string | Detailed description     | "Record of Customer Details" |
| `response_data`        | array  | Customer account details | See below                    |

### Response Data Fields

| Field             | Type   | Required | Description            | Example        |
| ----------------- | ------ | -------- | ---------------------- | -------------- |
| `national_id`     | string | Yes      | CID number             | "10705001283"  |
| `account_number`  | string | Yes      | DK Bank account number | "100100366202" |
| `citizen_country` | string | Yes      | Country of citizenship | "Bhutan"       |
| `first_name`      | string | Yes      | First name             | "Sangay"       |
| `middle_name`     | string | No       | Middle name            | null           |
| `last_name`       | string | Yes      | Last name              | "Wangdi"       |
| `phone_number`    | string | No       | Phone number           | "17123456"     |

## Implementation Details

### Files Created/Modified

#### 1. **DTO Files**

- ✅ `src/modules/payment/dtos/client-inquiry.dto.ts` - Request DTO
- ✅ `src/modules/payment/dtos/client-inquiry-response.dto.ts` - Response DTO (updated with phone_number)

#### 2. **Controller**

- ✅ `src/modules/payment/payment.controller.ts`
  - Added `clientInquiry()` endpoint
  - Added Swagger documentation

#### 3. **Service**

- ✅ `src/modules/payment/payment.service.ts`
  - Added `clientInquiry()` method
  - Added comprehensive logging

#### 4. **DK Account Service**

- ✅ `src/modules/payment/services/dk-gateway/dk-account.service.ts`
  - Added `clientInquiry()` method
  - Calls DK Gateway CLIENT_INQUIRY endpoint

## Flow Diagram

```
Client Request
  ↓
POST /api/payments/client-inquiry
  ↓
PaymentController.clientInquiry()
  ↓
PaymentService.clientInquiry()
  ↓
DKAccountService.clientInquiry()
  ↓
DKClientService.post() → DK Gateway API
  ↓
Response: Customer details + all accounts
  ↓
Log complete response
  ↓
Return to client
```

## DK Gateway Integration

### Endpoint Used

- **POST** `/v1/inquiry/client`

### Headers (Same as Fund Transfer)

- `Content-Type`: application/json
- `Authorization`: Bearer token
- Additional DK Gateway headers

### Request to DK Gateway

```json
{
  "request_id": "auto-generated-30-digit-id",
  "id_type": "CID",
  "id_number": "10705001283"
}
```

### Response from DK Gateway

```json
{
  "response_code": "0000",
  "response_message": "Success",
  "response_description": "Record of Customer Details",
  "response_data": [
    {
      "national_id": "10705001283",
      "account_number": "100100366202",
      "citizen_country": "Bhutan",
      "first_name": "Sangay",
      "middle_name": null,
      "last_name": "Wangdi",
      "phone_number": "17123456"
    }
  ]
}
```

## Logging

The implementation includes detailed logging at multiple levels:

### 1. Payment Service Level

```typescript
this.logger.log(`Client inquiry for CID: ${dto.id_number}`);
this.logger.log(`DK Gateway Client Inquiry Response: ${JSON.stringify(response, null, 2)}`);
```

### 2. DK Account Service Level

```typescript
this.logger.log(`Performing client inquiry for CID: ${dto.id_number}`);
this.logger.log(`DK Gateway raw response: ${JSON.stringify(response, null, 2)}`);
```

This allows you to see:

- ✅ The exact request being sent to DK Gateway
- ✅ The complete raw response from DK Gateway
- ✅ All parameters and fields in the response

## Usage Example

### Using cURL

```bash
curl -X POST http://localhost:3000/api/payments/client-inquiry \
  -H "Content-Type: application/json" \
  -d '{
    "id_type": "CID",
    "id_number": "10705001283"
  }'
```

### Using Postman

1. Method: POST
2. URL: `http://localhost:3000/api/payments/client-inquiry`
3. Headers: `Content-Type: application/json`
4. Body (raw JSON):

```json
{
  "id_type": "CID",
  "id_number": "10705001283"
}
```

## Testing

### Test Cases

#### 1. Valid CID

- Input: Valid 11-digit CID
- Expected: List of accounts with customer details

#### 2. Invalid CID Format

- Input: CID with wrong length
- Expected: 400 Bad Request

#### 3. CID Not Found

- Input: Valid format but non-existent CID
- Expected: 200 OK with response_code "3001"

#### 4. Multiple Accounts

- Input: CID with multiple bank accounts
- Expected: Array with all accounts

## Benefits

✅ **Complete Customer View** - Get all customer details in one call
✅ **Multiple Accounts** - Returns all linked bank accounts
✅ **Detailed Logging** - Full visibility into DK Gateway responses
✅ **Public Endpoint** - No authentication required
✅ **Swagger Documentation** - Full API docs with examples
✅ **Type Safety** - Proper TypeScript types for request/response

## Difference from Account Verification

| Feature           | Client Inquiry        | Account Verification |
| ----------------- | --------------------- | -------------------- |
| Input             | CID only              | CID only             |
| Returns           | All customer accounts | First account only   |
| Customer Info     | ✅ Full details       | ❌ Limited           |
| Phone Number      | ✅ Yes                | ❌ No                |
| Multiple Accounts | ✅ Yes                | ❌ No (first only)   |
| Use Case          | Customer lookup       | Payment processing   |

---

**Implementation Complete!** 🎉

The client inquiry endpoint is now available in Swagger UI and ready for testing.
