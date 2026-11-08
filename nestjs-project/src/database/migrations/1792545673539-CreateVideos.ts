import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateVideos1792545673539 implements MigrationInterface {
  name = 'CreateVideos1792545673539';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."videos_status_enum" AS ENUM('draft', 'processing', 'ready', 'failed')`,
    );
    await queryRunner.query(
      `CREATE TABLE "videos" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "channel_id" uuid NOT NULL, "title" character varying(100) NOT NULL, "slug" character varying(16) NOT NULL, "status" "public"."videos_status_enum" NOT NULL DEFAULT 'draft', "original_filename" character varying(255) NOT NULL, "content_type" character varying(100) NOT NULL, "size_bytes" bigint NOT NULL, "storage_key" character varying(512) NOT NULL, "upload_id" character varying(1024), "thumbnail_key" character varying(512), "duration_seconds" numeric(10,3), "metadata" jsonb, "processing_error" text, "processed_at" TIMESTAMP, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_5dbcc1ee100f853490582eccc71" UNIQUE ("slug"), CONSTRAINT "PK_e4c86c0cf95aff16e9fb8220f6b" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_ece1558efc6efd53eb530479db" ON "videos" ("status") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_350c48c9093177350f2c50e650" ON "videos" ("channel_id", "created_at") `,
    );
    await queryRunner.query(
      `ALTER TABLE "videos" ADD CONSTRAINT "FK_023a8e4f3f1a34ff3d8ca04a4cc" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "videos" DROP CONSTRAINT "FK_023a8e4f3f1a34ff3d8ca04a4cc"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_350c48c9093177350f2c50e650"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_ece1558efc6efd53eb530479db"`,
    );
    await queryRunner.query(`DROP TABLE "videos"`);
    await queryRunner.query(`DROP TYPE "public"."videos_status_enum"`);
  }
}
