import { Global, Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ALL_ENTITIES } from "./entities";

// Postgres connection (Docker container in dev, same image on EC2 in prod).
//
// DB_SYNC=true has TypeORM create/alter tables from the entity definitions —
// how ES Studio runs, and what makes a fresh `docker compose up` immediately
// usable. Switch it off and generate migrations once there's data worth
// protecting.
//
// @Global so every feature module can inject repositories via
// TypeOrmModule.forFeature([...]) without re-importing the connection.
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
