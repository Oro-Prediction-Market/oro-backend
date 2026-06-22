import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsString, IsNotEmpty, IsOptional } from "class-validator";

export class AddOutcomeDto {
  @ApiProperty({ description: "Label for the new outcome, e.g. \"Draw\"" })
  @IsString()
  @IsNotEmpty()
  label: string;

  @ApiPropertyOptional({ description: "Optional image URL for the outcome" })
  @IsOptional()
  @IsString()
  imageUrl?: string | null;
}
