import { ApiProperty } from "@nestjs/swagger";

export class HealthCheckResponse {
  @ApiProperty({ description: "Overall health status" })
  status: "healthy" | "degraded" | "unhealthy";

  @ApiProperty({ description: "Timestamp of the check" })
  timestamp: string;

  @ApiProperty({ description: "Uptime in seconds" })
  uptime: number;

  @ApiProperty({ description: "Database connection status" })
  database: {
    status: "connected" | "disconnected";
    responseTime?: number;
  };

  @ApiProperty({ description: "Redis connection status" })
  redis: {
    status: "connected" | "disconnected";
    responseTime?: number;
  };

  @ApiProperty({ description: "System memory usage" })
  memory: {
    used: number; // RSS (Resident Set Size) in MB - actual memory used by process
    total: number; // Heap total in MB - allocated heap memory
    percentage: number; // Heap usage percentage (used/total)
  };

  @ApiProperty({ description: "API response time in ms" })
  apiResponseTime: number;
}
