import { Global, Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ALL_ENTITIES } from "./entities";

// Postgres connection. DB_SYNC=true syncs the schema from entity definitions.
// @Global so feature modules can inject repositories without re-importing.
@Global()
@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: "postgres",
      host: process.env.DB_HOST || "localhost",
      port: Number(process.env.DB_PORT) || 5432,
      username: process.env.DB_USERNAME || "postgres",
      password: process.env.DB_PASSWORD || "password",
      database: process.env.DB_NAME || "posting_pilot_db",
      entities: ALL_ENTITIES,
      synchronize: (process.env.DB_SYNC || "true").toLowerCase() === "true",
      // Postgres returns numeric/bigint as strings by default; the app treats
      // engagement numbers as numbers, so normalise at the driver level.
      logging: (process.env.DB_LOGGING || "").toLowerCase() === "true" ? "all" : ["error"],
    }),
    TypeOrmModule.forFeature(ALL_ENTITIES),
  ],
  exports: [TypeOrmModule],
})
export class DatabaseModule {}
