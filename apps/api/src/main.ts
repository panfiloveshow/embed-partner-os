import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { AppModule } from "./app.module.js";
import { ProblemDetailsFilter } from "./problem-details.filter.js";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { cors: false });
  app.setGlobalPrefix("api/v1");
  app.enableCors({
    origin: [/^http:\/\/(?:localhost|127\.0\.0\.1):\d+$/],
    credentials: true,
  });
  app.useGlobalFilters(new ProblemDetailsFilter());

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

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, "127.0.0.1");
  console.log(`Embed Partner OS API: http://127.0.0.1:${port}/api/v1`);
  console.log(`OpenAPI UI: http://127.0.0.1:${port}/api/docs`);
}

void bootstrap();
