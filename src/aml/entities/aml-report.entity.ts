import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from "typeorm";

export enum AmlReportType {
  PERIODIC = "periodic",
  SAR = "sar",
}

@Entity("aml_reports")
export class AmlReport {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "varchar" })
  reportType: AmlReportType;

  @Column({ type: "timestamptz" })
  periodFrom: Date;

  @Column({ type: "timestamptz" })
  periodTo: Date;

  @Column({ type: "jsonb", default: [] })
  alertIds: string[];

  @Column({ type: "int", default: 0 })
  totalAlerts: number;

  @Column({ type: "int", default: 0 })
  highRiskCount: number;

  @Column({ type: "int", default: 0 })
  mediumRiskCount: number;

  @Column({ type: "int", default: 0 })
  lowRiskCount: number;

  @Column({ type: "int", default: 0 })
  affectedUsers: number;

  @Column({ type: "uuid" })
  generatedBy: string;

  @Column({ type: "varchar", nullable: true })
  generatedByName: string | null;

  @Column({ type: "text", nullable: true })
  notes: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
