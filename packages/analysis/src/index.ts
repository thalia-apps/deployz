/**
 * @deployz/analysis — the pure, deterministic §18/§19/§20 repository analysis
 * core: file-tree detectors, §10 rejection checks, the analyser orchestrator,
 * and the §19 compatibility rules engine.
 *
 * This package has ZERO dependencies on the rest of the monorepo (aside from
 * a test-only devDependency on @deployz/db for enum-drift assertions) so it
 * can be safely imported by BOTH @deployz/cdk and @deployz/api without
 * creating a workspace dependency cycle (cdk already depends on api).
 */

export type {
  FileTree,
  DetectorFinding,
  DetectorSource,
  MigrationRunnerVerdict,
  PostgresRequirement,
  RuntimeFamily,
} from './detectors.js';
export {
  detectDockerfile,
  listDockerfileCandidates,
  detectFramework,
  detectPort,
  detectHealthEndpoint,
  detectEnvVars,
  detectEnvVarModel,
  detectPostgresql,
  assessPostgres,
  detectLocalFilesystem,
  detectWorker,
  detectS3,
  detectMigrationCommand,
  detectStartupCommand,
  detectRuntime,
  migrationRunnerVerdict,
  detectBindAddress,
  detectDockerfileBuildContext,
  detectDockerfileBuildTarget,
  detectHostValidation,
  detectGitCopyInDockerfile,
  detectExternalServices,
  detectExternalServiceRequirements,
  collectScripts,
  collectScriptsWithDir,
  selectMigrationScript,
  dockerfileWorkdirs,
  detectDeclaredWorkerCommands,
  detectDeclaredWorkerCommand,
  isDevToolCommand,
  mainCommandRunsWorker,
  isRuntimeSourcePath,
  // DEPLOY-029: shared with apps/api's GitHub tree-fetch boundary, which
  // walks the same Dockerfile CMD/ENTRYPOINT script chain
  // `detectStartupMigrationEvidence` follows, so it can protect those exact
  // paths from the ANALYSIS_MAX_FILES trim.
  extractCmdScriptPaths,
  CMD_REGEX,
  ENTRYPOINT_REGEX,
  CMD_CHAIN_MAX_DEPTH,
  collectDependencyNames,
} from './detectors.js';
export type {
  ExternalServiceDefinition,
  ExternalServiceRequirement,
} from './detectors.js';
export { EXTERNAL_SERVICE_CATALOG, TREE_PATHS } from './detectors.js';

export type { RejectionFinding } from './rejection.js';
export {
  DATABASE_REJECTION_TOKENS,
  checkRedisUnsupported,
  checkMysql,
  checkMongo,
  checkElasticsearch,
  checkOtherUnsupportedDatabases,
  checkSqlite,
  checkKafka,
  checkRabbitMq,
  checkKubernetes,
  checkServerless,
  checkDockerComposeMultiService,
  checkPersistentVolumes,
  checkTerraform,
  checkPulumi,
  checkCloudFormation,
  checkAzure,
  checkGcp,
  checkGpu,
  checkNoBuildableDockerfile,
} from './rejection.js';

export type {
  RedisConfidence,
  RedisPurpose,
  RedisCompatibility,
  RedisRequirement,
  RedisEnvBindingKind,
  RedisEnvBinding,
} from './redis.js';
export { assessRedis, resolveRedisEnvBindings } from './redis.js';

export type { AnalysisResult, DatabaseState } from './analyser.js';
export { analyseRepo } from './analyser.js';
export type { ResourceOverrides } from './analyser.js';
export * from './ai-analysis/index.js';

export type { AsyncWorkloadsResult } from './async-detection.js';
export { detectAsyncWorkloads } from './async-detection.js';

export type { ApplicationAnalysisContext } from './application-analysis.js';
export { buildApplicationAnalysis, readApplicationAnalysis } from './application-analysis.js';

export type {
  AnalysisAmbiguityKind,
  AnalysisAmbiguity,
  EvidenceItem,
  RepositoryEvidence,
} from './evidence.js';
export { deriveAmbiguities, collectRepositoryEvidence, legacyQuestionString } from './evidence.js';

export type {
  BindingResource,
  BindingSemantic,
  InfrastructureBinding,
} from './bindings.js';
export { deriveInfrastructureBindings, derivedS3EnvValue } from './bindings.js';
export { derivedUrlEnvValue, isDerivedUrlEnvVariable } from './derived-url.js';

export type {
  CompatibilityVerdict,
  IssueSeverity,
  CompatibilityIssue,
  CompatibilityResult,
  PersistedVerdict,
  VerdictStore,
} from './rules.js';
export { evaluateCompatibility, persistVerdict } from './rules.js';

export type {
  ReadinessState,
  FindingSeverity,
  FindingConfidence,
  FixClass,
  DeployabilityOutcome,
  ReadinessFinding,
  PassedCheck,
  ReadinessReport,
  ReadinessReportContext,
  ReadinessResolution,
} from './readiness-report.js';
export { buildReadinessReport, reconcileReadiness, verdictFromReadiness } from './readiness-report.js';
export type { VendorResourceOverrides } from './vendor-disputes.js';
export { vendorResourceOverrides } from './vendor-disputes.js';

export type { ManifestSource, ManifestReadinessContext } from './manifest.js';
export { normalizeDeploymentManifest, evaluateManifestReadiness, generatedEnvKeys, mintedEnvKeys } from './manifest.js';

export type { EnvClassificationContext } from './env-classification.js';
export {
  MANAGED_DATABASE_ENV_VARS,
  MANAGED_STORAGE_ENV_VARS,
  classifyEnvVariables,
  isGeneratableSecretName,
} from './env-classification.js';

export type {
  FixInstructionsEnvRequirements,
  FixInstructionsFacts,
  FixInstructionsContext,
  FixInstructionsAiOutput,
  RemediationClass,
  RemediationConfidence,
  RemediationItem,
} from './fix-instructions.js';
export {
  FIX_INSTRUCTIONS_GUARDRAIL,
  FIX_INSTRUCTIONS_MAX_OUTPUT_TOKENS,
  FIX_INSTRUCTIONS_MAX_PROMPT_TOKENS,
  FIX_INSTRUCTIONS_MAX_TOTAL_TOKENS,
  FIX_INSTRUCTIONS_TIMEOUT_MS,
  FIX_INSTRUCTIONS_VERSION,
  buildFixInstructionsAiPrompt,
  assembleFixInstructions,
  fixInstructionsAiSchema,
  generateFixInstructions,
  isSafeGuidance,
  planRemediation,
  summariseEnvRequirements,
} from './fix-instructions.js';

export type { FailureCode, StructuredEvent } from './failure-codes.js';
export { FAILURE_CODES } from './failure-codes.js';

export type { Remediation } from './remediation.js';
export { getRemediation } from './remediation.js';

export type {
  AiGateway,
  AiGatewayConfig,
  AiGatewayResponse,
  AiGenerateOptions,
  TokenUsage,
} from './ai-gateway.js';
export {
  AiGatewayNotAvailableError,
  AiModelMismatchError,
  DEFAULT_TIMEOUT_MS,
  MAX_OUTPUT_TOKENS,
  MAX_PROMPT_TOKENS,
  MAX_TOTAL_TOKENS,
  SpendLimitExceededError,
  createAiGateway,
  estimateTokens,
  truncateToTokens,
} from './ai-gateway.js';

export type {
  DiagnosticConfidence,
  DiagnosticExplainOptions,
  DiagnosticExplanation,
} from './diagnostic-explainer.js';
export {
  buildDiagnosticPrompt,
  diagnosticExplanationSchema,
  explainDiagnostic,
} from './diagnostic-explainer.js';

export type { NormalizeErrorTextOptions } from './redact.js';
export { normalizeErrorText, redactSecrets } from './redact.js';

export type {
  RepositoryAiInput,
  RepositoryAiAnalysis,
  AiMergeOutcome,
} from './repository-ai.js';
export {
  REPO_AI_MAX_PROMPT_TOKENS,
  REPO_AI_MAX_TOTAL_TOKENS,
  REPO_AI_TIMEOUT_MS,
  REPOSITORY_AI_PROMPT_VERSION,
  MAX_AI_CONTEXT_FILES,
  MAX_AI_FILE_CHARS,
  repositoryAiSchema,
  aiFieldSchema,
  collectUnresolvedQuestions,
  selectAiContextFiles,
  buildRepositoryAiPrompt,
  analyseRepositoryWithAi,
  mergeAiAnalysis,
} from './repository-ai.js';

export type { JevEvidence, JevEvidenceInput } from './jev/evidence.js';
export {
  JEV_EVIDENCE_SCHEMA_VERSION,
  buildJevEvidence,
  fingerprintJevEvidence,
  jevEvidenceSchema,
  redactText,
  sanitizeSnippet,
} from './jev/evidence.js';

export { JEV_DECISION_SET_VERSION, REQUIREMENTS_NOUL_IDS, buildRequirementsQuestions } from './jev/questions.js';

export type {
  JevAgreement,
  JevCapabilityDecision,
  JevRequirementsShadowInput,
  JevRequirementsShadowResult,
} from './jev/verify.js';
export { runJevRequirementsShadow } from './jev/verify.js';

export type { JevClient, JevClientConfig } from './jev/client.js';
export { createJevClient } from './jev/client.js';
export { createFixtureJevClient } from './jev/fixture.js';
export { createJevCircuitBreaker } from './jev/circuit-breaker.js';
export { JevError } from './jev/errors.js';

export type { JevFailureEvidence, JevFailureEvidenceInput } from './jev/failure-evidence.js';
export {
  JEV_FAILURE_EVIDENCE_SCHEMA_VERSION,
  buildJevFailureEvidence,
  jevFailureEvidenceSchema,
} from './jev/failure-evidence.js';

export type {
  JevFailureClassificationResult,
  JevFailureDomain,
  JevFailureShadowInput,
} from './jev/failure-classify.js';
export {
  FAILURE_DOMAINS,
  JEV_FAILURE_DECISION_SET_VERSION,
  buildFailureQuestions,
  runJevFailureClassification,
} from './jev/failure-classify.js';

export { manifestToApplicationGraph, buildApplicationGraph } from './graph.js';
export { resolveResourceCapability, buildCapabilityConfiguration } from './resolver.js';
export {
  applicationGraphHash,
  planApplicationGraph,
  buildDeploymentSpecV2,
  planApplicationGraphWithSpec,
} from './planner.js';

export type { CompilerPreflightInput, CompilerPreflightResult } from './compiler-preflight.js';
export { evaluateCompilerPreflight } from './compiler-preflight.js';
