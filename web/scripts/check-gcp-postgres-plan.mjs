import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const plan = JSON.parse(
  await readFile(resolve(import.meta.dirname, '../deploy/gcp-postgres-staging-plan.json'), 'utf8'),
);

assert.equal(plan.schemaVersion, 1);
assert.equal(plan.kind, 'gcp-postgres-staging-proposal');
assert.ok(['proposal-only','approved-staging-bundle'].includes(plan.status));
const approved = plan.status === 'approved-staging-bundle';
assert.equal(plan.authorization.publicRolloutAuthorized,false);
assert.equal(plan.authorization.provisioningAuthorized,approved);
assert.equal(plan.authorization.deploymentAuthorized,approved);
if (approved) assert.equal(plan.authorization.authorizationReference,'user-approval-2026-09-30-gcp-postgres-staging-bundle');
else assert.equal(plan.authorization.authorizationReference,null);
assert.deepEqual(plan.authorization.requestedActivationBundle.ongoingMonthlyEstimateUsd, {
  minimum: 10,
  maximum: 12,
});
assert.equal(plan.authorization.requestedActivationBundle.oneTimeValidationUsageCapUsd, 3);
assert.equal(plan.authorization.requestedActivationBundle.newPaidProviderCalls, 0);
assert.equal(plan.authorization.requestedActivationBundle.isolatedRestoreMaximumHours, 2);
assert.ok(plan.authorization.requestedActivationBundle.includes.length >= 5);
for (const expansion of ['public or production', 'paid-provider', 'tier increase', 'storage above 10 GiB', 'PITR'])
  assert.ok(plan.authorization.additionalApprovalRequiredFor.some((item) => item.includes(expansion)));
assert.equal(plan.location.projectId, 'biplan-staging-efeblk');
assert.equal(plan.location.region, 'us-central1');
assert.equal(plan.location.environment, 'staging');

const { instance, database, databasePrincipals, iam, runtimeLimits, budget } = plan.resources;
assert.deepEqual(
  [instance.name, instance.edition, instance.databaseVersion, instance.tier, instance.availabilityType],
  ['biplan-staging-catalog-pg17', 'ENTERPRISE', 'POSTGRES_17', 'db-f1-micro', 'ZONAL'],
);
assert.equal(instance.highAvailability, false);
assert.equal(instance.deletionProtection, true);
assert.deepEqual(instance.disk, { type: 'PD_SSD', sizeGiB: 10, autoResize: false, hardCapacityGiB: 10 });
assert.equal(instance.network.ipv4Enabled, true);
assert.deepEqual(instance.network.authorizedNetworks, []);
assert.equal(instance.network.privateIp, false);
assert.equal(instance.network.vpcConnector, false);
assert.equal(instance.network.publicDatabaseExposure, false);
assert.match(instance.network.connection, /Cloud SQL connector.*\/cloudsql/);
assert.deepEqual(instance.backup, {
  enabled: true,
  retentionCount: 7,
  pointInTimeRecovery: false,
});
assert.deepEqual(database.extensions, ['postgis', 'vector', 'pg_trgm']);
assert.equal(databasePrincipals.owner.login, false);
assert.equal(databasePrincipals.readRole.login, false);
assert.equal(databasePrincipals.prepareRole.login, false);
assert.equal(databasePrincipals.applicationUsesPostgresRole, false);
for (const login of [databasePrincipals.runtimeLogin, databasePrincipals.preparationLogin]) {
  assert.equal(login.superuser, false);
  assert.equal(login.createDatabase, false);
  assert.equal(login.createRole, false);
}
assert.notEqual(databasePrincipals.runtimeLogin.secret, databasePrincipals.preparationLogin.secret);
assert.equal(iam.cloudSqlRole, 'roles/cloudsql.client');
assert.deepEqual(iam.runtimeSecretAccess, ['biplan-staging-db-runtime-password']);
assert.deepEqual(iam.preparationSecretAccess, ['biplan-staging-db-preparation-password']);
assert.deepEqual(
  [runtimeLimits.cloudRunMinInstances, runtimeLimits.cloudRunMaxInstances, runtimeLimits.runtimePoolMax],
  [0, 1, 2],
);
assert.equal(runtimeLimits.preparationJobParallelism, 1);
assert.ok(runtimeLimits.preparationJobMaxRetries <= 1);
assert.ok(runtimeLimits.preparationPoolMax <= 2);
assert.equal(runtimeLimits.transactionsMustNotSpanExternalCalls, true);
assert.deepEqual(budget, {
  existingAlertCurrency: 'TRY',
  existingAlertAmount: 100,
  changeExistingAlert: false,
  alertIsSpendingCap: false,
});

assert.equal(plan.cost.currency, 'USD');
assert.deepEqual(plan.cost.expectedMonthlyRange, { minimum: 10, maximum: 12 });
assert.equal(plan.cost.tryConversionProvided, false);
assert.equal(plan.cost.sla, false);
assert.equal(plan.cost.productionSizingClaimed, false);
assert.equal(plan.migration.newAiCalls, 0);
assert.equal(plan.migration.includedInRequestedActivationBundle, true);
assert.equal(plan.migration.keepFirestoreAndSnapshotsOperational, true);
assert.equal(plan.migration.keepPreviousImmutableImage, true);
assert.equal(plan.scaleUpGate.allowedWithoutNewApproval, false);

console.log(`GCP PostgreSQL staging bundle is internally consistent; authorization: ${approved ? 'bounded staging only' : 'proposal only'}.`);
