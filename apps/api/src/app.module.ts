import { Module } from "@nestjs/common";
import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { TodayController } from "./today.controller.js";
import { TodayService } from "./today.service.js";
import { TODAY_PORT } from "./today.port.js";
import { PostgresTodayService } from "./persistence/postgres-today.service.js";
import { PrismaService } from "./persistence/prisma.service.js";
import { ContactController } from "./contact.controller.js";
import { CONTACT_PORT } from "./contact.port.js";
import { PostgresContactService } from "./persistence/postgres-contact.service.js";
import { ContactMergeController } from "./contact-merge.controller.js";
import { ReportController } from "./report.controller.js";
import { REPORT_PORT } from "./report.port.js";
import { ReportService } from "./report.service.js";
import { PostgresReportService } from "./persistence/postgres-report.service.js";
import { PlacementController } from "./placement.controller.js";
import { PlacementService } from "./placement.service.js";
import { PLACEMENT_PORT } from "./placement.port.js";
import { L0EmbedChecker } from "./monitoring/l0-embed-checker.js";
import { L0_CHECKER } from "./monitoring/l0-checker.port.js";
import { PostgresPlacementService } from "./persistence/postgres-placement.service.js";
import { OpportunityController } from "./opportunity.controller.js";
import { OPPORTUNITY_PORT } from "./opportunity.port.js";
import { OpportunityService } from "./opportunity.service.js";
import { PostgresOpportunityService } from "./persistence/postgres-opportunity.service.js";
import { OrganizationImportController } from "./organization-import.controller.js";
import { ORGANIZATION_IMPORT_PORT } from "./organization-import.port.js";
import { OrganizationImportService } from "./organization-import.service.js";
import { PostgresOrganizationImportService } from "./persistence/postgres-organization-import.service.js";
import { RadarController } from "./radar.controller.js";
import { RADAR_PORT } from "./radar.port.js";
import { RadarService } from "./radar.service.js";
import { RADAR_INSPECTOR, RadarPageInspector } from "./monitoring/radar-page-inspector.js";
import { trafficProviderFromEnvironment } from "./monitoring/radar-traffic-provider.js";
import { PostgresRadarService } from "./persistence/postgres-radar.service.js";
import { PartnerController } from "./partner.controller.js";
import { PARTNER_PORT } from "./partner.port.js";
import { PartnerService } from "./partner.service.js";
import { PostgresPartnerService } from "./persistence/postgres-partner.service.js";
import {
  ACTOR_IDENTITY,
  AccessControlGuard,
  ActorIdentityService,
} from "./auth/access-control.js";
import { SessionController } from "./auth/session.controller.js";
import { SlaSettingsController } from "./sla-settings.controller.js";
import { SLA_SETTINGS_PORT } from "./sla-settings.port.js";
import { SlaSettingsService } from "./sla-settings.service.js";
import { PostgresSlaSettingsService } from "./persistence/postgres-sla-settings.service.js";
import {
  EnvironmentOidcTokenVerifier,
  OIDC_TOKEN_VERIFIER,
} from "./auth/oidc-token-verifier.js";
import { AccessAdministrationController } from "./access-administration.controller.js";
import { AccessAdministrationService } from "./access-administration.service.js";
import {
  ActorContextInterceptor,
  ActorExecutionContext,
} from "./auth/actor-execution-context.js";
import { PersistenceActorService } from "./persistence/persistence-actor.service.js";

@Module({
  controllers: [
    TodayController,
    ContactController,
    ContactMergeController,
    ReportController,
    PlacementController,
    OpportunityController,
    OrganizationImportController,
    RadarController,
    PartnerController,
    SessionController,
    SlaSettingsController,
    AccessAdministrationController,
  ],
  providers: [
    TodayService,
    PrismaService,
    PostgresTodayService,
    PostgresContactService,
    ReportService,
    PostgresReportService,
    PlacementService,
    PostgresPlacementService,
    OpportunityService,
    PostgresOpportunityService,
    OrganizationImportService,
    PostgresOrganizationImportService,
    RadarService,
    PostgresRadarService,
    PartnerService,
    PostgresPartnerService,
    SlaSettingsService,
    PostgresSlaSettingsService,
    AccessAdministrationService,
    EnvironmentOidcTokenVerifier,
    ActorIdentityService,
    AccessControlGuard,
    ActorExecutionContext,
    ActorContextInterceptor,
    PersistenceActorService,
    {
      provide: ACTOR_IDENTITY,
      useExisting: ActorIdentityService,
    },
    {
      provide: OIDC_TOKEN_VERIFIER,
      useExisting: EnvironmentOidcTokenVerifier,
    },
    {
      provide: APP_GUARD,
      useExisting: AccessControlGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useExisting: ActorContextInterceptor,
    },
    {
      provide: L0_CHECKER,
      useFactory: () => new L0EmbedChecker(),
    },
    {
      provide: RADAR_INSPECTOR,
      useFactory: () => new RadarPageInspector(undefined, undefined, trafficProviderFromEnvironment()),
    },
    {
      provide: TODAY_PORT,
      inject: [TodayService, PostgresTodayService],
      useFactory: (memory: TodayService, postgres: PostgresTodayService) =>
        process.env.PERSISTENCE_MODE === "postgres" ? postgres : memory,
    },
    {
      provide: CONTACT_PORT,
      inject: [TodayService, PostgresContactService],
      useFactory: (memory: TodayService, postgres: PostgresContactService) =>
        process.env.PERSISTENCE_MODE === "postgres" ? postgres : memory,
    },
    {
      provide: REPORT_PORT,
      inject: [ReportService, PostgresReportService],
      useFactory: (memory: ReportService, postgres: PostgresReportService) =>
        process.env.PERSISTENCE_MODE === "postgres" ? postgres : memory,
    },
    {
      provide: PLACEMENT_PORT,
      inject: [PlacementService, PostgresPlacementService],
      useFactory: (memory: PlacementService, postgres: PostgresPlacementService) =>
        process.env.PERSISTENCE_MODE === "postgres" ? postgres : memory,
    },
    {
      provide: OPPORTUNITY_PORT,
      inject: [OpportunityService, PostgresOpportunityService],
      useFactory: (memory: OpportunityService, postgres: PostgresOpportunityService) =>
        process.env.PERSISTENCE_MODE === "postgres" ? postgres : memory,
    },
    {
      provide: ORGANIZATION_IMPORT_PORT,
      inject: [OrganizationImportService, PostgresOrganizationImportService],
      useFactory: (
        memory: OrganizationImportService,
        postgres: PostgresOrganizationImportService,
      ) => process.env.PERSISTENCE_MODE === "postgres" ? postgres : memory,
    },
    {
      provide: RADAR_PORT,
      inject: [RadarService, PostgresRadarService],
      useFactory: (memory: RadarService, postgres: PostgresRadarService) =>
        process.env.PERSISTENCE_MODE === "postgres" ? postgres : memory,
    },
    {
      provide: PARTNER_PORT,
      inject: [PartnerService, PostgresPartnerService],
      useFactory: (memory: PartnerService, postgres: PostgresPartnerService) =>
        process.env.PERSISTENCE_MODE === "postgres" ? postgres : memory,
    },
    {
      provide: SLA_SETTINGS_PORT,
      inject: [SlaSettingsService, PostgresSlaSettingsService],
      useFactory: (memory: SlaSettingsService, postgres: PostgresSlaSettingsService) =>
        process.env.PERSISTENCE_MODE === "postgres" ? postgres : memory,
    },
  ],
})
export class AppModule {}
