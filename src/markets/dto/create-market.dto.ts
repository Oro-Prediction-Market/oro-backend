import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsString,
  IsOptional,
  IsNumber,
  IsDateString,
  IsArray,
  Min,
  Max,
} from "class-validator";
import { Transform } from "class-transformer";

export class OutcomeInputDto {
  label: string;
  imageUrl?: string | null;
}

export class CreateMarketDto {
  @ApiProperty() @IsString() title: string;
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() imageUrl?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() imageUrlAlt?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() resolutionCriteria?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() opensAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() closesAt?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(50)
  houseEdgePct?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(100)
  liquidityParam?: number;

  @ApiProperty({
    description:
      'Outcome labels as strings ["Team A", "Team B"] or objects [{ label: "Team A", imageUrl: "https://..." }]',
  })
  @IsArray()
  @Transform(({ value }) => {
    if (!Array.isArray(value)) return value;
    // Normalise to OutcomeInputDto objects
    return value.map((item: any) => {
      if (typeof item === "string") return { label: item, imageUrl: null };
      return { label: item.label, imageUrl: item.imageUrl ?? null };
    });
  })
  outcomes: OutcomeInputDto[];

  /** football-data.org match ID — set when creating a market from a fixture */
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  externalMatchId?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  externalSource?: string;

  /** "match-winner" | "over-under" — used by the keeper to auto-propose results */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  externalMarketType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  category?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  mechanism?: string;
}
