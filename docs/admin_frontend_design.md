# Admin Frontend Design & Integration Guide

This document outlines the recommended structure and integration patterns for building an admin dashboard for the Oro Prediction Market.

## 1. Page Architecture

We recommend a simple, sidebar-based layout with the following main views:

### Dashboard (Home)
- **Purpose**: Quick overview of the system state.
- **Key Stats**: Total active markets, total pool volume (across all markets), count of unsettled markets.
- **Backend Source**: `GET /admin/markets` (summary calculation on frontend).

### Market Management
- **Purpose**: Lifecycle control for all prediction markets.
- **Features**:
  - Filter by status (Upcoming, Open, Closed, Resolved, Cancelled).
  - List of markets with "Transition State" (e.g., Open to Closed) and "Resolve" buttons.
  - "Create New Market" button.
- **Backend Source**: `GET /admin/markets`, `PATCH /admin/markets/:id/status`.

### User Management
- **Purpose**: Monitor user activity and manage permissions.
- **Features**:
  - List all users (ID, telegramId, Name, Balance).
  - Toggle Admin switch (Promote/Demote others).
- **Backend Source**: `GET /admin/users`, `PATCH /admin/users/:id/admin`.

---

## 2. Integration Example (React with TMA)

Since the frontend is built with React and `@tma.js/sdk-react`, you can use a custom hook to manage admin API calls.

### Example Hook: `useAdminApi.ts`
```typescript
import { useInitData } from "@tma.js/sdk-react";

export const useAdminApi = () => {
  const initData = useInitData(); // Get Telegram Init Data for auth
  const token = localStorage.getItem("admin_token"); // Or however you store it

  const apiFetch = async (path: string, options: RequestInit = {}) => {
    const response = await fetch(`http://localhost:3000/admin${path}`, {
      ...options,
      headers: {
        ...options.headers,
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });
    if (!response.ok) throw new Error("API Request Failed");
    return response.json();
  };

  return {
    getMarkets: () => apiFetch("/markets"),
    createMarket: (data: any) => apiFetch("/markets", { method: "POST", body: JSON.stringify(data) }),
    transitionMarket: (id: string, status: string) => apiFetch(`/markets/${id}/status`, { 
      method: "PATCH", 
      body: JSON.stringify({ status }) 
    }),
    resolveMarket: (id: string, winningOutcomeId: string) => apiFetch(`/markets/${id}/resolve`, {
      method: "POST",
      body: JSON.stringify({ winningOutcomeId })
    }),
    toggleAdmin: (userId: string, isAdmin: boolean) => apiFetch(`/users/${userId}/admin`, {
       method: "PATCH",
       body: JSON.stringify({ isAdmin })
    }),
  };
};
```

---

## 3. Recommended UI Components

### Market Status Badges
Use consistent colors for different market states:
- `Upcoming`: Gray
- `Open`: Green
- `Closed`: Orange
- `Resolved`: Blue
- `Cancelled`: Red

### Resolution Workflow
When an admin clicks "Resolve", they should be presented with a list of the market's outcomes to select the winner.
1. `GET /admin/markets/:id` to fetch outcomes.
2. Render a radio list of outcome labels.
3. Call `POST /admin/markets/:id/resolve` with the selected outcome UUID.

---

> [!TIP]
> Since this is a Telegram Mini App, you can restrict access to certain pages by checking `initData.user.id` against a whitelist of admin IDs or the `isAdmin` flag from your backend response.
> 
> For local development, check [Admin Auth Integration Guide](./admin_auth_integration.md) to learn how to get a token without Telegram!
