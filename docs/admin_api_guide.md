# Admin API Integration Guide

This document provides the necessary information to integrate an admin dashboard with the Oro Prediction Market backend.

## Base URL
`http://localhost:3000/admin` (Default development environment)

## Authentication
All admin endpoints require a **Bearer Token** with admin privileges. 

> [!TIP]
> See the [Admin Auth Integration Guide](./admin_auth_integration.md) for detailed instructions on how to obtain a token.

- **Header:** `Authorization: Bearer <JWT_TOKEN>`
- **Prerequisite:** The user MUST have `isAdmin: true` in the database.

## Endpoints

### 1. Market Management

#### Create a New Market
- **URL:** `POST /admin/markets`
- **Body:** `CreateMarketDto`
```json
{
  "title": "Will BTC reach $100k by end of 2024?",
  "description": "Prediction on Bitcoin price performance.",
  "outcomes": ["Yes", "No"],
  "opensAt": "2024-01-01T00:00:00Z",
  "closesAt": "2024-12-31T23:59:59Z",
  "houseEdgePct": 5
}
```

#### List All Markets
- **URL:** `GET /admin/markets`
- **Returns:** Array of Market objects.

#### Market Status Transition
- **URL:** `PATCH /admin/markets/:id/status`
- **Body:**
```json
{
  "status": "Open" // Upcoming, Open, Closed, Cancelled
}
```

#### Resolve Market (Set Winner)
- **URL:** `POST /admin/markets/:id/resolve`
- **Body:**
```json
{
  "winningOutcomeId": "uuid-of-the-winner"
}
```

#### Update Market
- **URL:** `PATCH /admin/markets/:id`
- **Body:** `Partial<CreateMarketDto>` (Updates title, description, etc.)

#### Delete Market
- **URL:** `DELETE /admin/markets/:id`
- **Condition:** Only `Upcoming` status markets can be deleted.

### 2. Monitoring & Data

#### Pool Breakdown
- **URL:** `GET /admin/markets/:id/pool`
- **Returns:** Detailed view of the parimutuel pool, house edge calculation, and current odds.

#### Settlements
- **URL:** `GET /admin/settlements`
- **Returns:** History of all payouts made for resolved markets.

#### User Management
- **URL:** `GET /admin/users`
- **Returns:** List of all registered users and their details.

#### Toggle Admin Status
- **URL:** `PATCH /admin/users/:id/admin`
- **Body:**
```json
{
  "isAdmin": true
}
```

## Integration Tips
- Use the `ApiBearerAuth` header for all requests.
- Handle 403 Forbidden errors if the current user is not an admin.
- Use the `MarketStatus` enum for consistent state management in the UI.
