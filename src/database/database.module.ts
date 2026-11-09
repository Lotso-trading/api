import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";

const mongoUri =
  Deno.env.get("MONGODB_URI") ||
  "mongodb://root:example@localhost:27017/polymarket_copy?authSource=admin";

@Module({
  imports: [
    MongooseModule.forRoot(mongoUri, {
      maxPoolSize: 20,
      minPoolSize: 5,
      serverSelectionTimeoutMS: 5000,
    }),
  ],
  exports: [MongooseModule],
})
export class DatabaseModule {}
