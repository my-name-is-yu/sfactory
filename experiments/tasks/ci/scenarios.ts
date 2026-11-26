/**
 * CI Failure Triage: the root causes the mock CI can exhibit.
 *
 * A scenario is one root cause. It says what the failing logs contain, what the pull request
 * changed, and how the job behaved on main recently. `category` and `key` are gold: the mock CI
 * never serves them.
 */

export interface DiffFile {
	path: string;
	patch: string;
}

export interface Scenario {
	key: string;
	category: "regression" | "flaky" | "infra" | "dependency" | "config" | "unknown";
	/** Failing runs this cause produces. Several jobs of one PR, or the same job on several PRs. */
	runs: { job: string; step: string; error: string[]; after?: string[] }[];
	/** true: each run is on its own PR, whose diff has nothing to do with the failure. */
	acrossPrs?: boolean;
	/** The PR's change, when one PR is behind all runs. */
	diff?: DiffFile[];
	/** Indices (0 = most recent) of the last ten main runs of the job that failed, and with what. */
	mainFailures?: { at: number[]; tests?: string[]; error?: string };
	/** A line of the dependency-install step: in this run, and in green runs on main. */
	install?: { now: string; green: string };
}

const f = (path: string, patch: string): DiffFile => ({ path, patch });

export const UNRELATED_DIFFS: DiffFile[][] = [
	[f("docs/onboarding.md", "@@ -12,3 +12,4 @@\n ## Setup\n-Run `make dev`.\n+Run `make dev` and wait for the seed step.\n+See also docs/faq.md.")],
	[f("web/src/styles/card.css", "@@ -4,2 +4,2 @@\n .card {\n-  padding: 12px;\n+  padding: 16px;")],
	[f("README.md", "@@ -1,2 +1,2 @@\n-# Orders service\n+# Orders Service")],
	[f("web/src/pages/About.tsx", '@@ -8,1 +8,1 @@\n-  <p>Founded in 2019.</p>\n+  <p>Founded in 2019 in Rotterdam.</p>')],
	[f("scripts/release-notes.sh", "@@ -3,1 +3,1 @@\n-echo \"Collecting notes\"\n+echo \"Collecting release notes\"")],
	[f("api/handlers/health.py", '@@ -5,1 +5,1 @@\n-    return {"ok": True}\n+    return {"ok": True, "service": "orders"}')],
];

export const SCENARIOS: Record<string, Scenario> = {
	// ---- regressions: the PR's own change broke product or test code ----
	price_rounding: {
		key: "price_rounding",
		category: "regression",
		diff: [f("src/pricing/round.ts", "@@ -3,3 +3,3 @@\n export function roundPrice(value: number): number {\n-  return Math.round(value * 100) / 100;\n+  return Math.floor(value * 100) / 100;\n }")],
		runs: [
			{ job: "unit", step: "npm test", error: ["FAIL tests/pricing/round.test.ts", "  ● roundPrice › rounds half up", "    Expected: 10.35", "    Received: 10.34", "Tests: 1 failed, 412 passed"] },
			{ job: "integration", step: "npm run test:integration", error: ["FAIL tests/integration/checkout.test.ts", "  ● checkout › totals a two-line cart", "    Expected: 20.70", "    Received: 20.68", "Tests: 1 failed, 57 passed"] },
		],
	},
	queue_deadlock: {
		key: "queue_deadlock",
		category: "regression",
		diff: [f("src/queue/worker.ts", "@@ -21,4 +21,5 @@\n   async drain() {\n     await this.lock.acquire();\n+    await this.flushMetrics(); // flushMetrics also takes this.lock\n     for (const job of this.pending) await this.run(job);")],
		runs: [{ job: "unit", step: "npm test", error: ["RUNS  tests/queue/worker.test.ts", "  ● worker › drains the queue", "    thrown: \"Exceeded timeout of 30000 ms for a test.\"", "Tests: 1 failed, 388 passed"], after: ["##[warning]Step is approaching the job timeout of 60 minutes"] }],
	},
	null_user_serializer: {
		key: "null_user_serializer",
		category: "regression",
		diff: [f("api/serializers/user.py", "@@ -14,3 +14,3 @@\n def serialize(user):\n-    return {\"id\": user.id, \"email\": user.email if user else None}\n+    return {\"id\": user.id, \"email\": user.profile.email}")],
		runs: [
			{
				job: "api-tests",
				step: "pytest -x tests/api",
				error: ["tests/api/test_users.py::test_anonymous_profile FAILED", "E   AttributeError: 'NoneType' object has no attribute 'email'", "api/serializers/user.py:16: AttributeError"],
				after: ["WARNING teardown: ConnectionResetError(104, 'Connection reset by peer') while closing test database", "WARNING teardown: retrying close (1/3)", "WARNING teardown: closed", "===== 1 failed, 203 passed in 41.20s ====="],
			},
		],
	},
	migration_missing_column: {
		key: "migration_missing_column",
		category: "regression",
		diff: [
			f("api/models/order.py", "@@ -9,2 +9,3 @@\n class Order(Model):\n     total = DecimalField()\n+    region = CharField(max_length=8)"),
			f("api/handlers/orders.py", "@@ -30,1 +30,1 @@\n-    rows = Order.objects.values(\"id\", \"total\")\n+    rows = Order.objects.values(\"id\", \"total\", \"region\")"),
		],
		runs: [{ job: "api-tests", step: "pytest -x tests/api", error: ["tests/api/test_orders.py::test_list_orders FAILED", "E   django.db.utils.ProgrammingError: column orders.region does not exist", "===== 1 failed, 96 passed in 18.03s ====="] }],
	},
	order_id_type: {
		key: "order_id_type",
		category: "regression",
		diff: [f("src/types/order.ts", "@@ -1,1 +1,2 @@\n-export type OrderId = string;\n+export type OrderId = string & { readonly __brand: \"OrderId\" };\n+export const asOrderId = (value: string) => value as OrderId;")],
		runs: [{ job: "build", step: "npm run build", error: ["src/checkout/submit.ts(44,27): error TS2345: Argument of type 'string' is not assignable to parameter of type 'OrderId'.", "Found 1 error in src/checkout/submit.ts:44"] }],
	},
	button_snapshot: {
		key: "button_snapshot",
		category: "regression",
		diff: [f("web/src/components/Button.tsx", '@@ -6,1 +6,1 @@\n-  return <button className="btn btn-primary">{label}</button>;\n+  return <button className="btn btn-primary btn-rounded">{label}</button>;')],
		runs: [{ job: "web-unit", step: "npm test -- --ci", error: ["FAIL web/src/components/Button.test.tsx", "  ● Button › renders primary", "    expect(received).toMatchSnapshot()", "    - className=\"btn btn-primary\"", "    + className=\"btn btn-primary btn-rounded\"", " › 1 snapshot failed.", "Tests: 1 failed, 140 passed"] }],
	},

	// ---- flaky: fails on main too, unrelated to the change ----
	ws_reconnect_flaky: {
		key: "ws_reconnect_flaky",
		category: "flaky",
		acrossPrs: true,
		mainFailures: { at: [1, 4, 8], tests: ["tests/realtime/reconnect.test.ts › reconnects after a dropped socket"] },
		runs: [
			{ job: "unit", step: "npm test", error: ["FAIL tests/realtime/reconnect.test.ts", "  ● reconnects after a dropped socket", "    Expected: \"open\"", "    Received: \"connecting\"", "Tests: 1 failed, 412 passed"] },
			{ job: "unit", step: "npm test", error: ["FAIL tests/realtime/reconnect.test.ts", "  ● reconnects after a dropped socket", "    Expected: \"open\"", "    Received: \"connecting\"", "Tests: 1 failed, 412 passed"] },
		],
	},
	midnight_date_flaky: {
		key: "midnight_date_flaky",
		category: "flaky",
		// The PR touches billing code, but not the date formatter that fails.
		diff: [f("src/billing/invoice.ts", "@@ -18,1 +18,1 @@\n-  const due = addDays(issued, 14);\n+  const due = addDays(issued, 30);")],
		mainFailures: { at: [2, 9], tests: ["tests/util/date.test.ts › formats today as a weekday name"] },
		runs: [{ job: "unit", step: "npm test", error: ["FAIL tests/util/date.test.ts", "  ● formats today as a weekday name", "    Expected: \"Tuesday\"", "    Received: \"Wednesday\"", "Tests: 1 failed, 412 passed"] }],
	},
	cache_order_flaky: {
		key: "cache_order_flaky",
		category: "flaky",
		// The PR adds a test in the same directory, in a different file.
		diff: [f("tests/cache/test_ttl.py", "@@ -0,0 +1,4 @@\n+def test_ttl_default(cache):\n+    cache.set(\"a\", 1)\n+    assert cache.ttl(\"a\") == 300")],
		mainFailures: { at: [0, 3, 5, 6], tests: ["tests/cache/test_eviction.py::test_evicts_least_recent"] },
		runs: [{ job: "api-tests", step: "pytest tests", error: ["tests/cache/test_eviction.py::test_evicts_least_recent FAILED", "E   assert 3 == 2", "E    +  where 3 = len(cache.keys())", "===== 1 failed, 204 passed in 39.77s ====="] }],
	},

	// ---- infra: the runner or its surroundings, not the code ----
	runner_oom: {
		key: "runner_oom",
		category: "infra",
		diff: UNRELATED_DIFFS[1],
		runs: [{ job: "build", step: "npm run build", error: ["webpack 5.91.0 compiling...", "<--- Last few GCs --->", "/home/runner/work/_temp/build.sh: line 3:  2217 Killed                  node node_modules/.bin/webpack", "##[error]The runner has received a shutdown signal. Process exited with code 137."] }],
	},
	registry_503: {
		key: "registry_503",
		category: "infra",
		acrossPrs: true,
		mainFailures: { at: [0], error: "npm ERR! 503 Service Unavailable - GET https://registry.npmjs.org/@types%2fnode" },
		runs: [
			{ job: "unit", step: "npm ci", error: ["npm ERR! code E503", "npm ERR! 503 Service Unavailable - GET https://registry.npmjs.org/@types%2fnode", "npm ERR! A complete log of this run can be found in: /home/runner/.npm/_logs/debug-0.log"] },
			{ job: "build", step: "npm ci", error: ["npm ERR! code E503", "npm ERR! 503 Service Unavailable - GET https://registry.npmjs.org/webpack", "npm ERR! A complete log of this run can be found in: /home/runner/.npm/_logs/debug-0.log"] },
		],
	},
	disk_full: {
		key: "disk_full",
		category: "infra",
		diff: UNRELATED_DIFFS[5],
		runs: [{ job: "docker", step: "docker build -t orders:ci .", error: ["#14 [build 6/9] RUN pip install -r requirements.txt", "#14 ERROR: failed to copy files: write /var/lib/docker/overlay2/9f3c/diff/usr/lib/python3.12/site-packages/numpy/core/_multiarray.so: no space left on device", "ERROR: failed to solve: failed to copy files: no space left on device"] }],
	},
	runner_lost: {
		key: "runner_lost",
		category: "infra",
		diff: UNRELATED_DIFFS[3],
		// Tests were running when the runner vanished; the last test line is a consequence, not the cause.
		runs: [{ job: "integration", step: "npm run test:integration", error: ["RUNS  tests/integration/refunds.test.ts", "##[error]The hosted runner lost communication with the server. Anything in your workflow that terminates the runner process, starves it for CPU/Memory, or blocks its network access can cause this error."] }],
	},

	// ---- dependency: something upstream changed under an unchanged manifest ----
	eslint_plugin_major: {
		key: "eslint_plugin_major",
		category: "dependency",
		acrossPrs: true,
		install: { now: "+ eslint-plugin-import-order 9.0.0", green: "+ eslint-plugin-import-order 8.4.1" },
		mainFailures: { at: [0], error: "TypeError: context.getScope is not a function" },
		runs: [
			{ job: "lint", step: "npm run lint", error: ["Oops! Something went wrong! :(", "TypeError: context.getScope is not a function", "Rule: \"import-order/sorted\"", "    at node_modules/eslint-plugin-import-order/lib/rules/sorted.js:31:28"] },
			{ job: "lint", step: "npm run lint", error: ["Oops! Something went wrong! :(", "TypeError: context.getScope is not a function", "Rule: \"import-order/sorted\"", "    at node_modules/eslint-plugin-import-order/lib/rules/sorted.js:31:28"] },
		],
	},
	base_image_python: {
		key: "base_image_python",
		category: "dependency",
		acrossPrs: true,
		install: { now: "#3 [internal] load metadata for docker.io/library/python:3-slim -> resolved python 3.13.0", green: "#3 [internal] load metadata for docker.io/library/python:3-slim -> resolved python 3.12.7" },
		mainFailures: { at: [0], error: "ERROR: Could not find a version that satisfies the requirement numpy==1.26.4" },
		runs: [
			{ job: "docker", step: "docker build -t orders:ci .", error: ["#11 ERROR: Could not find a version that satisfies the requirement numpy==1.26.4 (from versions: 2.1.0, 2.1.1, 2.1.2)", "#11 ERROR: No matching distribution found for numpy==1.26.4", "ERROR: failed to solve: process \"/bin/sh -c pip install -r requirements.txt\" did not complete successfully: exit code: 1"] },
			{ job: "docker", step: "docker build -t orders:ci .", error: ["#11 ERROR: Could not find a version that satisfies the requirement numpy==1.26.4 (from versions: 2.1.0, 2.1.1, 2.1.2)", "#11 ERROR: No matching distribution found for numpy==1.26.4", "ERROR: failed to solve: process \"/bin/sh -c pip install -r requirements.txt\" did not complete successfully: exit code: 1"] },
		],
	},
	protobuf_transitive: {
		key: "protobuf_transitive",
		category: "dependency",
		acrossPrs: true,
		install: { now: "Successfully installed grpcio-tools-1.66.0 protobuf-5.28.0", green: "Successfully installed grpcio-tools-1.62.1 protobuf-4.25.3" },
		mainFailures: { at: [0, 1], error: "TypeError: Descriptors cannot be created directly." },
		runs: [
			{ job: "api-tests", step: "pytest tests", error: ["ImportError while loading conftest '/home/runner/work/orders/tests/conftest.py'.", "api/proto/orders_pb2.py:33: in <module>", "TypeError: Descriptors cannot be created directly.", "If this call came from a _pb2.py file, your generated code is out of date and must be regenerated with protoc >= 3.19.0."] },
			{ job: "api-tests", step: "pytest tests", error: ["ImportError while loading conftest '/home/runner/work/orders/tests/conftest.py'.", "api/proto/orders_pb2.py:33: in <module>", "TypeError: Descriptors cannot be created directly.", "If this call came from a _pb2.py file, your generated code is out of date and must be regenerated with protoc >= 3.19.0."] },
		],
	},

	// ---- config: the pipeline, its secrets or its environment ----
	missing_deploy_token: {
		key: "missing_deploy_token",
		category: "config",
		diff: UNRELATED_DIFFS[0],
		runs: [{ job: "deploy-preview", step: "Run acme/deploy-action@v3", error: ["##[error]Input required and not supplied: token", "Hint: secrets are not passed to workflows triggered from forks."] }],
	},
	ci_node_pin: {
		key: "ci_node_pin",
		category: "config",
		// The PR caused it, but by changing the pipeline, not the product.
		diff: [f(".github/workflows/ci.yml", "@@ -17,3 +17,3 @@\n       - uses: actions/setup-node@v4\n         with:\n-          node-version: 20\n+          node-version: 16")],
		runs: [
			{ job: "unit", step: "npm ci", error: ["npm ERR! code EBADENGINE", "npm ERR! engine Unsupported engine", "npm ERR! notsup Required: {\"node\":\">=20\"}", "npm ERR! notsup Actual:   {\"npm\":\"8.19.4\",\"node\":\"v16.20.2\"}"] },
			{ job: "build", step: "npm ci", error: ["npm ERR! code EBADENGINE", "npm ERR! engine Unsupported engine", "npm ERR! notsup Required: {\"node\":\">=20\"}", "npm ERR! notsup Actual:   {\"npm\":\"8.19.4\",\"node\":\"v16.20.2\"}"] },
		],
	},
	workflow_syntax: {
		key: "workflow_syntax",
		category: "config",
		diff: [f(".github/workflows/release.yml", "@@ -33,2 +33,3 @@\n     steps:\n-      - run: make release\n+      - run: make release\n+       env: RELEASE=1")],
		runs: [{ job: "release-check", step: "Set up job", error: ["##[error]Invalid workflow file: .github/workflows/release.yml#L35", "##[error]You have an error in your yaml syntax on line 35: mapping values are not allowed in this context"] }],
	},

	// ---- unknown: the evidence does not settle it ----
	truncated_log: {
		key: "truncated_log",
		category: "unknown",
		diff: [f("src/reports/monthly.ts", "@@ -50,1 +50,1 @@\n-  const rows = await loadRows(month);\n+  const rows = await loadRows(month, { includeDrafts: false });")],
		runs: [{ job: "integration", step: "npm run test:integration", error: ["> orders@4.2.0 test:integration", "> jest --config jest.integration.js"] }],
	},
	unexplained_failure: {
		key: "unexplained_failure",
		category: "unknown",
		// Fails in code the PR does not touch, with no failures on main and no dependency change.
		diff: UNRELATED_DIFFS[2],
		runs: [{ job: "api-tests", step: "pytest tests", error: ["tests/api/test_export.py::test_export_csv_headers FAILED", "E   AssertionError: assert ['id', 'total'] == ['id', 'total', 'currency']", "===== 1 failed, 204 passed in 40.02s ====="] }],
	},
};
