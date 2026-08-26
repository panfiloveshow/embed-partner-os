import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { AppModule } from "./app.module.js";
import { ProblemDetailsFilter } from "./problem-details.filter.js";

const DEV_ORIGIN_PATTERN = /^http:\/\/(?:localhost|127\.0\.0\.1):\d+$/;

function corsOrigins(): Array<string | RegExp> {
  const configured = (process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  return configured.length > 0 ? configured : [DEV_ORIGIN_PATTERN];
}

async function bootstrap() {
  const isProduction = process.env.NODE_ENV === "production";
  if (isProduction && process.env.PERSISTENCE_MODE !== "postgres") {
    console.error(
      "Configuration error: NODE_ENV=production requires PERSISTENCE_MODE=postgres. " +
        "The in-memory persistence mode loses all data on restart and must not serve production traffic.",
    );
    process.exit(1);
  }

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    cors: false,
    bodyParser: false,
  });
  app.setGlobalPrefix("api/v1");
  app.enableShutdownHooks();
  // File imports (CSV/XLSX) travel as multipart/form-data with their own
  // limits in the controllers, so a small JSON body limit is enough.
  app.useBodyParser("json", { limit: "1mb" });
  app.enableCors({
    origin: corsOrigins(),
    credentials: true,
  });
  app.useGlobalFilters(new ProblemDetailsFilter());

  if (!isProduction) {
    const openApiConfig = new DocumentBuilder()
      .setTitle("Embed Partner OS API")
      .setDescription("Операционное ядро развития эмбедной сети RUTUBE")
      .setVersion("1.0")
      .addTag("today")
      .addTag("reports")
      .addTag("placements")
      .build();
    const document = SwaggerModule.createDocument(app, openApiConfig);
    SwaggerModule.setup("api/docs", app, document);
  }

  const port = Number(process.env.PORT ?? 3000);
  // 127.0.0.1 по умолчанию для локальной разработки; в Docker/проде
  // задаётся HOST=0.0.0.0 (см. compose.prod.yaml).
  const host = process.env.HOST?.trim() || "127.0.0.1";
  await app.listen(port, host);
  console.log(`Embed Partner OS API: http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}/api/v1`);
  if (!isProduction) {
    console.log(`OpenAPI UI: http://127.0.0.1:${port}/api/docs`);
  }
}

void bootstrap();
