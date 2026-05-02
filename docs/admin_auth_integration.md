# Admin Authentication & Integration Guide

This document explains how to authenticate as an admin to access the Oro Prediction Market admin endpoints.

## 1. Authentication Flow

The backend uses **JWT (JSON Web Tokens)** for authentication. To access admin endpoints, your requests must include a valid JWT in the `Authorization` header.

### Header Format
```http
Authorization: Bearer <YOUR_JWT_TOKEN>
```

---

## 2. Obtaining an Admin Token

### A. standard Production Flow (TMA)
1. The frontend retrieves `initData` from the Telegram Mini App SDK.
2. The frontend calls `POST /auth/telegram` with the `initData`.
3. The backend validates the `initData` signature using the `BOT_TOKEN`.
4. If the user's `telegramId` matches an existing user with `isAdmin: true`, the backend returns a JWT containing the `isAdmin` claim.

### B. Development Flow (Fast-Track)
For local development, you can use these helper endpoints to get a token without needing a real Telegram environment.

#### 1. Generate Mock Init Data
Useful for testing the login flow with any Telegram ID.
- **Endpoint:** `GET /auth/dev/mock-init-data?id=123456789&username=testadmin`
- **Returns:** A signed `initData` string that you can then send to `POST /auth/telegram`.

#### 2. Get Admin Token Directly
The fastest way to get a working admin JWT.
- **Endpoint:** `GET /auth/dev/admin-token?secret=<ADMIN_DEV_SECRET>`
- **Prerequisite:** Set `ADMIN_DEV_SECRET` and `ADMIN_TELEGRAM_ID` in your backend `.env`.
- **Returns:** A JWT token valid for 7 days.

---

## 3. Admin Verification

The backend protects admin routes using an `AdminGuard`. It checks for:
1. A valid JWT.
2. The `isAdmin: true` flag on the user record in the database.

> [!IMPORTANT]
> To manually promote a user to admin in development:
> 1. Find the user's UUID in the `users` table.
> 2. Run: `UPDATE users SET "isAdmin" = true WHERE id = 'uuid-here';`

---

## 4. Integration Tips

- **Token Storage**: Store the token in `localStorage` or a secure cookie.
- **Auto-Login**: On app load, check if a token exists. If not, trigger the Telegram login flow.
- **Handling 403s**: If you receive a `403 Forbidden`, it means your token is valid but your user does not have `isAdmin: true`.

---

## 5. Oro-admin Project Setup

If you are using the `Oro-admin` companion project:
1. Ensure the `Oro/backend` is running at `http://localhost:3000`.
2. In `Oro-admin/.env`, set `VITE_API_BASE_URL=http://localhost:3000/admin`.
3. Launch `Oro-admin` with `npm run dev`.
4. The login screen will prompt you for your `ADMIN_DEV_SECRET` (from `Oro/backend/.env`).
5. Once authenticated, the token will be stored in `localStorage` and managed automatically.

> [!TIP]
> If you encounter CORS errors, ensure `http://localhost:5173` (or your current admin URL) is included in the `enableCors` origin list in `Oro/backend/src/main.ts`.
