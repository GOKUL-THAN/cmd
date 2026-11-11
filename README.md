#                           


> **Version:** 4.0.0  
> **Live Demo:** [https://clm-website-1cc7.vercel.app/](https://clm-website-1cc7.vercel.app/)  
> **GitHub:** [https://github.com/GOKUL-THAN/clm](https://github.com/GOKUL-THAN/clm)<br>
> **Status:** Demonstration / pre-production; current verification does not establish production readiness<br>
> **Architecture:** Zero-Trust Hybrid SaaS Control Plane + Customer In-VPC Satellite Gateway  

> **Verification snapshot (2026-11-06):** Staged SaaS, satellite-gateway,
> and vSatellite Go modules passed tests, `go vet`, and builds with Go 1.27.3.
> The gateway also passed a Linux/amd64 cross-build. SaaS database tests used a
> disposable PostgreSQL 18.6 app-role connection. The latest CI run passed all
> nine jobs, including Go race tests, PostgreSQL 15 RLS tests, container and
> dependency scans, Terraform validation, and build/scan/non-root checks for
> all three container images:
> [run 42257224350](https://github.com/GOKUL-THAN/clm/actions/runs/42257224350).
> The run uploaded a CycloneDX filesystem SBOM and generated an attestation,
> which was verified with GitHub CLI for this repository. This attestation
> covers the SBOM, not the container images.
> Kubernetes workload service accounts disable automatic API-token mounts;
> a cluster deployment was not tested. Provider integrations, staging, and
> production remain unverified. See
> [EXECUTION_CHECKPOINT.md](./EXECUTION_CHECKPOINT.md),
> [MASTER_REQUIREMENT_TRACKER.md](./MASTER_REQUIREMENT_TRACKER.md), and
> [DEVSECOPS_AND_STANDARDS_STATUS.md](./DEVSECOPS_AND_STANDARDS_STATUS.md).

---

## Table of Contents

1. [Overview](#1-overview)
2. [Quick Start](#2-quick-start)
3. [Demo Access and Preview](#3-demo-access-and-preview)
4. [Architecture](#4-architecture)
5. [The 26-Stage Contract Lifecycle](#5-the-26-stage-contract-lifecycle)
6. [Certificate Lifecycle Management](#6-certificate-lifecycle-management)
7. [Admin Portal — All Menu Pages](#7-admin-portal--all-menu-pages)
8. [API Reference](#8-api-reference)
9. [End-to-End Demo Walkthrough](#9-end-to-end-demo-walkthrough)
10. [Technology Stack](#10-technology-stack)
11. [Project Structure](#11-project-structure)
12. [Running Locally](#12-running-locally)
13. [Test Suites](#13-test-suites)
14. [Security Architecture](#14-security-architecture)
15. [400 Enterprise Features](#15-400-enterprise-features)
16. [Production Requirements](#16-production-requirements)
17. [Demo vs Production](#17-demo-vs-production)

---

## 1. Overview

The CLM repository combines an in-memory Node.js demonstration with Go services
for a contract-management control plane, certificate gateway, and vSatellite
agent. The demo and Go services are separate execution paths; a demo screen or
fixture is not evidence that a corresponding production integration is active.

- **Contract Lifecycle** — 26 stages from intake to AI-assisted archival, covering every department in the organization
- **Certificate/TLS Lifecycle** — Discovery, issuance, deployment, renewal, revocation via in-VPC satellite gateway

### Platform Numbers

| Metric | Value |
|---|---|
| Demo contract fixtures | 15 (illustrative, in-memory records) |
| Demo portfolio value | $14,745,000 (fixture data) |
| Feature registry entries | 400 across 20 domains; registry presence is not implementation proof |
| Mock API routes | Approximately 87; this is not the Go API endpoint count |
| Local Node checks | 40 scenario, 400 registry smoke, 26 lifecycle, 10 corporate, 3 workflow, and 15 global checks passed; these are not a measure of production coverage |
| Frontend pages | Portal navigation pages; not a measure of completed backend workflows |
| Go modules | SaaS control plane, satellite gateway, and vSatellite |
| Database migrations | 10 numbered application migrations (001–010), plus the separate Keycloak bootstrap migration |
| CA integrations | Adapters exist; live provider access depends on configuration and credentials |
| Certificate lifecycle stages | 6 |
| Compliance mappings | GDPR, PCI-DSS, SOC 2, HIPAA; no independent certification is claimed |

---

## 2. Quick Start

### Local demo (Node.js only; no database required)

```bash
# Clone the repository
git clone https://github.com/GOKUL-THAN/clm.git
cd clm

# Start the in-memory mock portals (Node.js 18+ required)
npm start

# Open browser
# Admin Portal:   http://localhost:3000
# Gateway Portal: http://localhost:8080
```

`npm start` serves local UI assets and mock APIs from `dev-server.js`; it does
not start the Go services, connect to PostgreSQL, or contact real certificate
authorities, cloud accounts, or endpoint agents. It listens on loopback.

### Other npm scripts

```bash
npm start                 # Start both portals
npm test                  # Run enterprise scenarios A-H (40 tests)
npm run test:lifecycle    # Run 26-stage lifecycle tests
npm run test:400          # Run 400 feature registry tests
npm run test:corporate    # Run corporate module tests
npm run demo:health       # Health check all endpoints
npm run demo:setup        # Set up the optional database-backed demo workflow
npm run demo:test         # Run that workflow (requires its documented setup)
npm run demo:stop         # Stop demo servers
```

---

## 3. Demo Access and Preview

The Node.js mock auth endpoint returns a fixed demo token and does not provide
production authentication. Do not enter real credentials, reuse a real
password, or treat a successful demo login as proof of identity controls.

The following links point to the configured demo deployment; availability and
access behavior may change:

**Demo URL:** [https://clm-website-1cc7.vercel.app/](https://clm-website-1cc7.vercel.app/)

**Gateway Portal:** [https://clm-website-1cc7.vercel.app/gateway](https://clm-website-1cc7.vercel.app/gateway)

**Health Check:** [https://clm-website-1cc7.vercel.app/api/v1/health](https://clm-website-1cc7.vercel.app/api/v1/health)

---

## 4. Architecture

The diagram below is the intended target architecture, not a depiction of the
local Node.js demo or evidence of a deployed production environment. The demo
portals and Go service modules are separate execution paths.

```
┌──────────────────────────────────────────────────────────────────────────┐
│                    INTERNET (Target SaaS deployment)                    │
│                                                                          │
│   Browser/API Client                                                     │
│        │                                                                 │
│        │ HTTPS + JWT (Keycloak OIDC)                                     │
│        ▼                                                                 │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │            SaaS Control Plane  (port 3000)                      │    │
│  │  Admin Portal │ REST API │ Keycloak Auth │ Fleet Mgmt           │    │
│  │  Contracts │ Approvals │ Templates │ AI Intelligence            │    │
│  │  Obligations │ Risk │ Compliance │ Integrations                │    │
│  │  PostgreSQL + Redis + S3 + Audit Event Sink                    │    │
│  └────────────────────────────────┬────────────────────────────────┘    │
│                                   │ intended outbound mTLS               │
│              ─── CUSTOMER TRUST BOUNDARY ───                            │
│  ┌────────────────────────────────▼────────────────────────────────┐    │
│  │         Satellite Gateway  (port 8080)                          │    │
│  │  Gateway Portal │ CA Adapters │ Key Custody │ Discovery         │    │
│  │  Certificate Deploy │ ACME │ Policies │ Scheduler              │    │
│  │  Local PostgreSQL │ Vault/HSM refs │ Encrypted spool           │    │
│  └────────────────────────────────┬────────────────────────────────┘    │
│                                   │ authenticated pull                   │
│               ┌───────────────────┼───────────────────┐                 │
│         ┌─────▼──────┐     ┌──────▼──────┐     ┌──────▼──────┐         │
│         │ vSatellite │     │ vSatellite  │     │ vSatellite  │         │
│         │  Cloud/VPC │     │ Kubernetes  │     │  On-Prem    │         │
│         └─────┬──────┘     └──────┬──────┘     └──────┬──────┘         │
│               └───────────────────┼───────────────────┘                 │
│                         deploy/scan/verify                               │
└──────────────────────────────────────────────────────────────────────────┘
```

The diagram shows the intended topology, not a claim that every agent operation
is enabled. The gateway deployment API currently runs deployments locally; its
vSatellite command endpoint accepts only `scan_cidr` and `health_check`.
Certificate deployment to vSatellites is disabled until tenant authorization
and authenticated deployment transport are available.

### Architectural Invariants

| ID | Rule |
|---|---|
| ARC-001 | Customer private keys never enter the SaaS control plane |
| ARC-002 | Operations run at the gateway that can reach the CA and endpoints |
| ARC-003 | Policy is centrally governed and locally enforceable offline |
| ARC-004 | Production certificate-deployment commands must be tenant-scoped, authenticated, and auditable; vSatellite certificate deployment is disabled until this is enforced |
| ARC-011 | Tenant data isolated at every layer (DB, cache, queue, logs) |
| ARC-012 | Security-sensitive state is fail-closed |

---

## 5. The 26-Stage Contract Lifecycle

```
MACRO 1 — INTAKE
  Stage 1 ▶ Request Intake & Triage       Self-service portal, dept tagging, budget validation
  Stage 2 ▶ Contract Intake               Auto-triage, risk pre-screening, legal assignment
  Stage 3 ▶ Contract Creation             Wizard metadata capture, counterparty verification

MACRO 2 — AUTHORING
  Stage 4 ▶ Contract Drafting             Dynamic clause assembly, jurisdiction rules
  Stage 5 ▶ Contract Authoring            Collaborative doc generation, variable replacement
  Stage 6 ▶ Template Management           Versioned NDA/MSA/SOW/SLA/Vendor template catalog
  Stage 7 ▶ Clause Library                Pre-approved clause repo with risk ratings

MACRO 3 — NEGOTIATION
  Stage 8 ▶ Contract Negotiation          Counterparty workspace, redlines, round tracking
  Stage 9 ▶ Contract Collaboration        Concurrent comments, internal legal notes
  Stage 10 ▶ Contract Review              Policy pre-flight, deviation flags, diff engine

MACRO 4 — APPROVAL & SIGNING
  Stage 11 ▶ Approval Workflow            L1 Manager → L2 Legal → L3 CISO & Finance
  Stage 12 ▶ Electronic Signature         ESIGN Act / eIDAS compliant, email OTP
  Stage 13 ▶ Digital Signature            X.509 PKI, hardware HSM, non-repudiation

MACRO 5 — EXECUTION
  Stage 14 ▶ Contract Execution           Tamper-evident PDF, sealed document ingestion
  Stage 15 ▶ Contract Repository          Full-text search, metadata filtering

MACRO 6 — POST-EXECUTION
  Stage 16 ▶ Contract Monitoring          SLA health, deadline notifications
  Stage 17 ▶ Obligation Management        Deliverable calendar, milestone tracking, penalties
  Stage 18 ▶ Compliance Management        GDPR, PCI-DSS, SOC 2, HIPAA verification
  Stage 19 ▶ Risk Management              Scorecards, liability caps, blast radius

MACRO 7 — RENEWAL / EXPIRY
  Stage 20 ▶ Contract Amendment           Versioned addendums
  Stage 21 ▶ Contract Renewal             90/60/30-day proactive alerts
  Stage 22 ▶ Contract Expiration          Grace period, auto-state transitions
  Stage 23 ▶ Contract Termination         Runbooks, survival clause tracking

MACRO 8 — ANALYTICS & AI
  Stage 24 ▶ Contract Analytics           Cycle times, bottlenecks, counterparty spend
  Stage 25 ▶ Contract Reporting           PDF/CSV/JSON auditor-ready exports
  Stage 26 ▶ AI Contract Intelligence     Clause extraction, risk detection, Q&A
```

The lifecycle harness's stage count does not establish that every stage is
implemented as a production workflow.

---

## 6. Certificate Lifecycle Management

The **Satellite Gateway Portal** (`/gateway`) provides certificate lifecycle
management inside the customer network. The stages below describe the product
lifecycle; provider and deployment capabilities depend on configuration, and
the gateway does not currently dispatch certificate deployments to vSatellites.

### Certificate Lifecycle Stages

```
Stage 1: Discovery      ──▶  CIDR scanning, DNS resolution, endpoint inventory
Stage 2: Issuance       ──▶  CA orders (Let's Encrypt, DigiCert, Private CA, AWS ACM)
Stage 3: Deployment     ──▶  Configured targets (gateway-local deployments; vSatellite deployment disabled)
Stage 4: Verification   ──▶  Endpoint health check, chain validation, TLS version
Stage 5: Renewal        ──▶  Automated scheduler, 30-day warning, ACME auto-renew
Stage 6: Revocation     ──▶  OCSP stapling, CRL distribution, emergency revoke
```

### Demo Certificate Inventory

The following inventory, provider orders, and deployment statuses are demo data;
they are not evidence of live CA or endpoint integrations.

| Domain | Issuer | Key | Days Left | Status |
|---|---|---|---|---|
| `*.enterprise.internal` | DigiCert TLS RSA SHA256 | RSA 2048 | 42 | Active |
| `api-uat.enterprise.internal` | Let's Encrypt | ECDSA P-256 | 12 | **Expiring Soon** |
| `internal-mgmt.local` | Enterprise Private CA | RSA 4096 | 280 | Active |

### Illustrative CA Provider Records

| Provider | Type | Status | Orders |
|---|---|---|---|
| Let's Encrypt | ACME | Active | 12 completed |
| DigiCert | API | Active | 3 completed, 1 pending |
| Enterprise Private CA | ADCS | Active | 8 completed |
| AWS ACM Private CA | AWS SDK | Inactive | Not configured |

### Deploy Targets

The entries below are illustrative demo records, not evidence that these
environments are connected or healthy.

| Target | Type | Cluster/Host | Status |
|---|---|---|---|
| AWS ALB Production | aws-alb | ap-south-1 | Healthy |
| Kubernetes Secret | k8s-secret | prod-cluster-01 | Healthy |
| Nginx On-Premises | file | 10.125.4.50 | Healthy |

### Certificate Policy Engine

| Policy | Type | Action | Status |
|---|---|---|---|
| Enforce RSA-2048 Minimum | key_strength | Block | Enabled |
| Auto-Renew 30 Days Before | renewal_window | Warn | Enabled |
| Production Requires EV | validation_level | Block | Disabled |
| Block Self-Signed in Prod | self_signed | Block | Enabled |
| Minimum TLS 1.2 | tls_version | Warn | Enabled |

---

## 7. Admin Portal — All Menu Pages

### SaaS Control Plane (`http://localhost:3000`)

This table describes portal navigation and example UI data. In local demo mode,
the Node.js server returns in-memory mock responses; labels such as “Live” do
not mean the page is connected to a production service.

| Menu | Page | API Endpoint | Data |
|---|---|---|---|
| Dashboard | Overview stats, satellites, approvals | Multiple | Mock summary |
| Contracts | Repository, 26-stage view, filter | `GET /api/v1/contracts` | 15 contracts, $14.7M |
| Contract Metrics | Portfolio analytics bar | `GET /api/v1/contracts/metrics` | 10 active, 3 negotiating |
| Intake & Requests | Request management, convert to contract | `GET /api/v1/contract-requests` | Mock response |
| Templates & Clauses | Template catalog, clause library | `GET /api/v1/templates` | 5+ templates |
| Negotiation & Redlines | Counterparty workspace, redline tracking | `GET /api/v1/negotiations/:id` | Active sessions |
| E-Sign & Digital PKI | Signature workflow, evidence bundles | `GET /api/v1/signatures/:id` | 24 signature records |
| Obligation Calendar | Milestone tracking, fulfillment | `GET /api/v1/obligations` | 3 obligations |
| Approval Hub | L1/L2/L3 pending queue | `GET /api/v1/approvals/pending` | 2 pending |
| AI Legal Intelligence | Analysis, extraction, Q&A | `GET /api/v1/ai-contracts/:id/analysis` | Risk + clauses |
| CLM Analytics | Compliance rate, spend analysis | `GET /api/v1/clm-reports/summary` | Illustrative metrics |
| Corporate Depts (14) | Department budgets and contracts | `GET /api/v1/corporate-departments` | 14 departments |
| Procurement & Suppliers | Supplier scorecards | `GET /api/v1/suppliers` | 3 suppliers |
| Legal Operations | Matter management, litigation hold | `GET /api/v1/legal-matters` | 2 matters |
| Financial & Spend | Commitment tracking, 3-way match | `GET /api/v1/financials` | Mock response |
| Risk Register | Cryptographic risk posture | `GET /api/v1/risk/posture` | Score: 28 |
| Webhooks & Integrations | Slack, ServiceNow, webhook mgmt | `GET /api/v1/integrations` | 2 integrations |
| ITSM War Room | Incident + service request tracking | `GET /api/v1/itsm/incidents` | Mock response |
| Departments & Budgets | Cost centers, cert quotas | `GET /api/v1/departments` | 3 departments |
| Cloud Accounts | AWS/GCP cloud account mgmt | `GET /api/v1/cloud-accounts` | 2 accounts |
| Gateways | Fleet management, deploy history | `GET /api/v1/satellites` | 1 gateway |
| Deploy Jobs | Terraform deploy job tracking | `GET /api/v1/satellites/deploy` | Mock response |
| Identity Management | Keycloak users, roles, groups | `GET /api/v1/identity/status` | Mock response |
| Onboarding | New customer preflight + bootstrap | `POST /api/v1/onboarding/preflight` | Mock flow |
| Directory Mappings | Group → role SSO mappings | `GET /api/v1/tenants/:id/sso/mappings` | Mock response |
| 400 Enterprise Features | Full feature domain explorer | `GET /api/v1/features` | 400 features |
| SDLC Workflows | Kiro workflow engine | `GET /api/v1/workflows/audit-log` | Mock response |
| Activity Log | Workflow + event history | Multiple | Demo event records |
| Organization Hub | Tenants, subscription, billing | `GET /api/v1/tenants` | 2 tenants |

### Gateway Portal (`http://localhost:8080`)

In local demo mode this portal also uses mock APIs. The Go gateway is a separate
service with its own routes and configuration.

| Menu | Data |
|---|---|
| Dashboard | Gateway status, cert counts, alerts |
| Certificate Inventory | 3 certs with expiry, status, key info |
| Discover & Scan | CIDR + DNS discovery engine |
| Issue Certificate | CA selection, CSR, order tracking |
| Deploy to Endpoints | Target selection, deployment jobs |
| CA Management | Provider config, accounts, order history |
| Policies | Enforcement rules engine |
| Scheduler | Automated job management |
| Credentials | Deploy + CA credential vault |
| Alerts | Critical/warning/info alert feed |
| Audit Log | Tamper-evident operation history |
| vSatellite Agents | Enrollment, heartbeat, capabilities |
| Compliance Report | GDPR/PCI-DSS/SOC 2/HIPAA posture |
| Multi-Cloud Sync | AWS ACM + GCP Certificate Manager |

---

## 8. API Reference

The paths below are an orientation to the demo and Go APIs, not a guarantee that
every route is exposed by every deployment. The Vercel function delegates to the
Node.js mock API; the Go control plane and gateway have separate routers. Check
the corresponding service router and deployment configuration for authoritative
route availability.

### Contract Management

```
GET    /api/v1/contracts                         List all contracts
POST   /api/v1/contracts                         Create new contract
GET    /api/v1/contracts/metrics                 Portfolio metrics
POST   /api/v1/contracts/:id/transition          Advance lifecycle stage
GET    /api/v1/contracts/:id/versions            Version history
GET    /api/v1/contract-requests                 List intake requests
POST   /api/v1/contract-requests                 Submit new request
POST   /api/v1/contract-requests/:id/convert     Convert to contract
GET    /api/v1/templates                         List contract templates
POST   /api/v1/templates/:id/instantiate         Create from template
GET    /api/v1/clauses                           Clause library
```

### Negotiation & Signatures

```
GET    /api/v1/negotiations/:id                  Negotiation session
GET    /api/v1/negotiations/:id/redlines         Redline list
POST   /api/v1/negotiations/:id/redlines         Submit redline
POST   /api/v1/negotiations/:id/redlines/:id/resolve  Resolve redline
GET    /api/v1/signatures/:id                    Signers for contract
POST   /api/v1/signatures/:id/sign               Execute signature
GET    /api/v1/signatures/:id/evidence           Cryptographic evidence bundle
```

### AI & Analytics

```
GET    /api/v1/ai-contracts/:id/analysis         AI contract analysis
POST   /api/v1/ai-contracts/:id/analyze          Trigger AI analysis
POST   /api/v1/ai-contracts/:id/ask              AI Q&A (natural language)
GET    /api/v1/clm-reports/summary               CLM analytics dashboard
GET    /api/v1/corporate-departments             14-department breakdown
```

### Approvals, Obligations, Risk

```
GET    /api/v1/approvals/pending                 Pending approval queue
POST   /api/v1/approvals/:id/approve             Approve request
POST   /api/v1/approvals/:id/reject              Reject request
GET    /api/v1/obligations                       Active obligations
GET    /api/v1/obligations/summary               Obligation KPIs
POST   /api/v1/obligations/:id                   Update obligation status
GET    /api/v1/risk/posture                      Risk register
GET    /api/v1/suppliers                         Supplier directory
GET    /api/v1/legal-matters                     Legal matter tracker
GET    /api/v1/financials                        Financial commitments
POST   /api/v1/financials/three-way-match        Reconcile PO/GR/Invoice
```

### Certificate Lifecycle (Gateway)

Certificate deployment through the gateway runs locally on that gateway.
Dispatching certificate deployment to vSatellites is disabled until tenant
authorization and authenticated deployment transport are available.

```
GET    /api/v1/status                            Gateway health
GET    /api/v1/certificates                      Certificate inventory
POST   /api/v1/certificates/issue                Issue new certificate
GET    /api/v1/certificates/:id                  Certificate detail
GET    /api/v1/ca/providers                      CA provider list
GET    /api/v1/ca/orders                         CA order history
POST   /api/v1/ca/quote                          Get CA pricing quote
GET    /api/v1/inventory                         Full cert inventory
GET    /api/v1/inventory/deployments             Deployment records
POST   /api/v1/discover                          Start CIDR discovery scan
POST   /api/v1/discover/dns                      DNS discovery
POST   /api/v1/deploy                            Deploy certificate
GET    /api/v1/deploy/targets                    Available deploy targets
GET    /api/v1/deploy/endpoints                  Monitored endpoints
GET    /api/v1/policies                          Certificate policies
POST   /api/v1/policies/evaluate                 Evaluate cert against policies
GET    /api/v1/scheduler                         Automated job schedule
POST   /api/v1/scheduler/run/:id                 Trigger job manually
GET    /api/v1/lifecycle                         Certificate lifecycle stages
GET    /api/v1/alerts                            Alert feed
GET    /api/v1/audit                             Gateway audit log
GET    /api/v1/credentials                       Credential vault
GET    /api/v1/acme/status                       ACME client status
POST   /api/v1/rotation/execute/:id              Execute cert rotation
GET    /api/v1/vsatellites                       vSatellite agent list
POST   /api/v1/vsatellites/enroll                Enroll new agent
GET    /api/v1/reports/compliance                Compliance report
```

### Identity & Tenants

```
GET    /api/v1/tenants                           Tenant list
GET    /api/v1/tenants/:id                       Tenant detail
GET    /api/v1/tenants/me                        Current caller tenant
GET    /api/v1/tenants/:id/sso/mappings          SSO group mappings
GET    /api/v1/users                             User list
GET    /api/v1/users/:id                         User detail
GET    /api/v1/identity/status                   Keycloak status
GET    /api/v1/identity/users                    IAM users
GET    /api/v1/identity/roles                    IAM roles
GET    /api/v1/identity/groups                   IAM groups
GET    /api/v1/identity/providers                SSO providers
GET    /api/v1/identity/sessions                 Active sessions
```

---

## 9. End-to-End Demo Walkthrough

This walkthrough uses seeded demo records and mock API responses. Mutations are
not durable and do not perform real contract signing, AI inference, CA issuance,
cloud changes, network scans, or certificate deployment. Do not use production
credentials or real target networks with the demo.

### Step 1 — Login

1. Start the local demo with `npm start` and open `http://localhost:3000`.
2. Use the sign-in screen to explore the demo UI; mock authentication returns a fixed demo token and is not real identity verification.
3. Click **Sign In**

### Step 2 — Dashboard

View the overview showing:
- **2 tenants**, **5 users**, **1 satellite gateway**
- **15 contracts** worth **$14.7M** total portfolio value
- **2 pending approvals** (L2 Security Review + L3 CISO Signoff)

### Step 3 — Contract Repository

Navigate to **Contracts Repository** to see all 15 contracts:
- Filter by type: MSA, NDA, SOW, SLA, Vendor, Employment
- Filter by lifecycle stage: Intake → Authoring → Negotiation → Approval → Signature → Post-Execution
- Click any contract to view details, version history, risk score, compliance status

### Step 4 — Create a Contract

1. Click **+ New Contract** button
2. Fill in title, type, counterparty, value, department
3. Select a template (MSA, NDA, SOW, SLA)
4. Submit — contract created at **Intake** stage

### Step 5 — Negotiate a Contract

1. Open `cnt-002` (Cloud Infrastructure — in negotiation)
2. Navigate to **Negotiations** tab
3. View active redlines from counterparty
4. Accept or reject each redline with comments

### Step 6 — Approval Workflow

1. Navigate to **Approvals Hub**
2. View 2 pending approvals:
   - `appr-001`: L2 — wildcard SSL certificate creation
   - `appr-002`: L3 — EV Multi-Domain cert purchase ($899)
3. Click **Approve** or **Reject** with comment
4. Observe multi-tier progression

### Step 7 — E-Signature

1. Open `cnt-003` (Mutual NDA — ready for signature)
2. Navigate to **E-Sign & Digital PKI** tab
3. View 2 signers: 1 signed, 1 awaiting
4. Click **Sign Contract** for the pending signer
5. View the demo evidence bundle (SHA-256 hash and timestamp); it is not a real signature or compliance certification

### Step 8 — AI Contract Intelligence

1. Navigate to **AI Legal Intelligence**
2. Select any contract
3. View auto-generated analysis: risk score, extracted clauses, compliance flags
4. Ask the AI Legal Assistant: *"What are the payment terms?"*
5. Receive answer with section citations and confidence score

### Step 9 — Certificate Management (Gateway Portal)

1. Open [https://clm-website-1cc7.vercel.app/gateway](https://clm-website-1cc7.vercel.app/gateway)
2. View the illustrative certificate fixtures (their expiry values are demo data)
3. Navigate to **CA Management** → inspect the provider UI and mock responses
4. Navigate to **Discover** → review the demo scan flow; do not scan a real network
5. Navigate to **Policies** and **Scheduler** → inspect the UI behavior only

### Step 10 — Compliance & Audit

1. Navigate to **CLM Analytics & Reports** and **Risk Register** to inspect illustrative metrics
2. Navigate to **Activity Log** to inspect demo event records (not a production audit)
3. Gateway: open **Compliance Report** to inspect the demo report presentation

---

## 10. Technology Stack

### Demo / Frontend

| Component | Technology |
|---|---|
| Server | Node.js 18+ (built-in `http` module; see `package.json`) |
| Admin Portal | Vanilla JS, HTML5, CSS3 |
| Gateway Portal | Vanilla JS, HTML5, CSS3 |
| API Engine | `dev-server.js` (in-memory mock APIs) |
| Deployment | Vercel configuration rewrites API requests to `/api/index.js`, which delegates to the mock API |
| Auth (demo) | Mock endpoint returns a fixed token; not suitable for access control |

### Go services

| Component | Technology |
|---|---|
| Modules | SaaS control plane, satellite gateway, and vSatellite; each has its own `go.mod` |
| Go version | Modules declare Go 1.26.0; CI and the latest local verification use Go 1.27.3 |
| Dependencies | PostgreSQL driver, JWT, AWS SDK, Gin, Cobra, Viper, Zap, and crypto libraries as applicable per module |
| Database isolation | PostgreSQL Row Level Security on covered tenant-owned tables; see the verification caveats in [Security Architecture](#14-security-architecture) |

### Infrastructure

The repository includes deployment templates; their presence does not indicate
that a cloud account, cluster, observability stack, or provider integration has
been provisioned or validated.

| Component | Technology |
|---|---|
| Containerization | Docker |
| Orchestration | Kubernetes (k8s manifests in `deploy/k8s/`) |
| IaC | Terraform (AWS, Azure, GCP under `deploy/terraform/`) |
| Observability | Prometheus + Grafana (`deploy/observability/`) |
| CI/CD | GitHub Actions (`.github/workflows/ci.yml`) |

---

## 11. Project Structure

```
CLM/
├── dev-server.js                    # Local in-memory mock server (ports 3000 and 8080)
├── api/
│   └── index.js                     # Vercel serverless function bridge
├── public/
│   ├── index.html                   # SaaS Admin Portal (port 3000)
│   ├── app.js                       # Admin portal app (~6000 lines)
│   └── gateway/
│       ├── index.html               # Gateway Portal (port 8080)
│       └── app.js                   # Gateway portal app (~5000 lines)
├── components/
│   ├── saas-control-plane/          # Go backend: SaaS orchestration
│   │   ├── internal/
│   │   │   ├── api/                 # REST API handlers
│   │   │   ├── core/                # Shared domain interfaces
│   │   │   ├── saas/                # Domain packages (20 packages)
│   │   │   │   ├── contract/        # 26-stage contract engine
│   │   │   │   ├── approval/        # Multi-tier approval workflow
│   │   │   │   ├── signature/       # E-sign + PKI
│   │   │   │   ├── negotiation/     # Redlines + collaboration
│   │   │   │   ├── aicontract/      # AI intelligence
│   │   │   │   ├── obligation/      # Post-execution tracking
│   │   │   │   ├── risk/            # Risk scorecards
│   │   │   │   ├── template/        # Template + clause library
│   │   │   │   ├── tenant/          # Multi-tenant management
│   │   │   │   ├── identity/        # Keycloak IAM
│   │   │   │   ├── integrations/    # Webhooks, ServiceNow, Slack
│   │   │   │   └── ...              # 10 more packages
│   │   │   └── store/               # Persistence and repository packages
│   │   ├── deploy/
│   │   │   └── migrations/          # Numbered application migrations 001–010
│   │   └── web/admin-portal/        # Compiled admin portal assets
│   ├── satellite-gateway/           # Go backend: In-VPC gateway
│   │   └── internal/
│   │       ├── ca/                  # CA adapters (ACME, DigiCert, ADCS)
│   │       ├── crypto/              # Key gen, CSR, HSM
│   │       ├── deployment/          # Certificate deployment engine
│   │       ├── discovery/           # CIDR + DNS scanning
│   │       ├── policy/              # Policy enforcement
│   │       ├── scheduler/           # Renewal + verification jobs
│   │       └── audit/               # Immutable event log
│   ├── vsatellite/                  # Lightweight endpoint agent
│   └── shared/                      # Common libraries
├── deploy/
│   ├── k8s/                         # 3 Kubernetes manifests
│   ├── terraform/                   # 3 Terraform configs (AWS/Azure/GCP)
│   └── observability/               # Prometheus + Grafana
├── features/                        # 400-feature registry (20 domains)
├── scripts/                         # Test, demo, and workflow scripts
│   ├── verify_scenarios_a_to_h.js   # 40 enterprise scenario tests
│   ├── test_lifecycle_26_stages.js  # 26 lifecycle stage tests
│   ├── test_400_features.js         # 400 feature smoke tests
│   ├── test_corporate_modules.js    # 10 corporate module tests
│   ├── health-check.js              # API health checker
│   ├── start-demo.js                # Demo startup script
│   └── stop-demo.js                 # Demo shutdown script
├── .kiro/
│   ├── workflows/                   # 4 Kiro AI workflow definitions
│   │   ├── clm-feature-dev.workflow.json
│   │   ├── clm-bugfix.workflow.json
│   │   ├── clm-plan-only.workflow.json
│   │   └── clm-specfast.workflow.json
│   └── steering/                    # AI context files
├── vercel.json                      # Vercel deployment configuration
├── package.json                     # Node.js package (v4.0.0)
├── Makefile                         # Go build targets
└── README.md                        # This file
```

---

## 12. Running Locally

### Prerequisites

| Tool | Version | Purpose |
|---|---|---|
| Node.js | >= 18.0.0 | Demo server (required) |
| Go | 1.27.3 for verified builds (modules declare Go 1.26.0) | Production backend (optional) |
| PostgreSQL | 14+ | Production database (optional) |
| Docker | latest | Container builds (optional) |

### Demo Mode (Node.js only)

```bash
# Start both portals
node dev-server.js

# Portals available at:
#   http://localhost:3000   Admin Portal
#   http://localhost:8080   Gateway Portal

# Stop server
node scripts/stop-demo.js
```

### Health Check

```bash
node scripts/health-check.js

# Or via curl
curl https://clm-website-1cc7.vercel.app/api/v1/health
```

### Go services (optional)

```bash
# Build the Go components using the repository staging helpers
make -C components/saas-control-plane build
make -C components/satellite-gateway build
```

These commands build the Go components; they do not deploy the services.
Before starting the SaaS control plane, apply its ordered application
migrations with `make -C components/saas-control-plane migrate`; the Compose
stack runs the same migration job before the server. Existing databases without
migration history require an explicitly validated legacy baseline via
`make -C components/saas-control-plane migrate-baseline`. Configure Keycloak
separately. The checked-in Kubernetes and Terraform files are templates, not a
verified production deployment procedure.

### Environment Variables

`.env.example` documents sample variables for local tooling and service setup.
The Node.js mock server does not automatically load `.env.local`; the ordinary
`npm start` demo uses in-memory data and does not require these settings. The
optional database-backed demo setup is described by `npm run demo:setup`.

Key variables:

```env
# Demo mode (no DB/Redis needed)
CLM_DEMO_MODE=true

# Production
DATABASE_URL=postgres://<user>:<password>@<host>:5432/<database>?sslmode=require
REDIS_URL=redis://localhost:6379
KEYCLOAK_URL=https://auth.enterprise.internal
KEYCLOAK_REALM=clm
JWT_SECRET=<256-bit-random-secret>
AWS_REGION=ap-south-1
```

---

## 13. Test Suites

```bash
# Suite 1: Enterprise Scenarios A through H
npm test

# Suite 2: 26 Contract Lifecycle Stages
npm run test:lifecycle

# Suite 3: 400 Feature Registry
npm run test:400

# Suite 4: Corporate Modules
npm run test:corporate

# Additional local suites
npm run test:workflows
npm run test:global

# Integration workflow (requires .env.demo.local and a disposable demo database)
npm run demo:test
```

The commands above are distinct harnesses, and their counts must not be added as a
single coverage figure. In particular, `test:400` checks registry entries and
wrappers; it does not prove that 400 independent business capabilities are
implemented. These Node checks do not replace Go compilation, PostgreSQL-backed
integration tests, live identity-provider verification, or deployment validation.
Scenario C runs in the local demo harness and is not the PostgreSQL RLS test;
see `DATABASE_VERIFICATION_REPORT.md` for the separate database evidence.

### Latest CI verification

GitHub Actions run
[42257224350](https://github.com/GOKUL-THAN/clm/actions/runs/42257224350)
passed all nine jobs on 2026-11-06. In addition to the Go module checks, CI
applied the numbered migrations to PostgreSQL 15 and ran application-role
approval and certificate tenant-isolation repository tests, Kubernetes
configuration assertions, Terraform validation, secret and vulnerability
scans, and builds/scans of the three container images. CI also uploaded a
CycloneDX filesystem SBOM and generated its provenance attestation; the
attestation was verified with GitHub CLI. This is repository/CI evidence, not
a staging or production deployment, and the attestation does not cover the
container images.

### What the Tests Verify

| Scenario | Tests | What it checks |
|---|---|---|
| A — Contract Lifecycle Flow | 4 | Intake → Authoring → Negotiation → Execution |
| B — Obligation & Financial | 4 | Milestones, 3-way invoice match, CLM analytics |
| C — Multi-Tenant Isolation | 4 | BOLA protection, cross-tenant data blocking |
| D — Delegation & Segregation | 4 | DOA matrix, approval segregation of duties |
| E — Digital Signature & PKI | 4 | SHA-256 digest, zero-knowledge verification |
| F — Satellite Gateway Resilience | 4 | Offline mode, queue drain, zero-egress AI |
| G — AI Safety & Prompt Injection | 4 | LLM guardrails, citation verification |
| H — Audit Trail Immutability | 4 | WORM triggers, RLS, tamper detection |

---

## 14. Security Architecture

### Security design and verification scope

- **Private-key isolation** — The architecture is intended to keep customer private-key operations inside the gateway; deployment and key-custody controls require environment-level verification.
- **mTLS** — Gateway-to-SaaS mutual TLS is an intended transport control; live end-to-end deployment verification is outstanding.
- **Tenant RLS** — Forced PostgreSQL Row Level Security is configured for covered tenant-owned tables. Migrations 001–010 and application-role/table-owner SQL suites passed on a disposable PostgreSQL 18.6 database. CI also passed on PostgreSQL 15, including app-role approval and certificate tenant-isolation repository tests. These results do not cover every repository or prove behavior in a deployed application.
- **JWT validation** — Go identity components include JWT validation; end-to-end authentication enforcement in a deployed service remains unverified. The Node demo uses mock auth.
- **Kubernetes workload identity** — The control-plane and gateway use dedicated ServiceAccounts with automatic Kubernetes API-token mounting disabled. No Kubernetes `Role` or `RoleBinding` is configured because the checked-in Go workloads do not use the Kubernetes API; cloud IAM/workload identity still requires environment-specific configuration and testing.
- **Fail-closed behavior** — Required controls must be tested in each configured deployment; the mock demo does not establish this property.

### Compliance

These are areas the project may map controls to; this table is not evidence of
an independent audit, certification, or complete regulatory compliance.

| Framework | Coverage |
|---|---|
| GDPR | Control areas to assess: data subject rights, retention, breach notification |
| PCI-DSS v4 | Control areas to assess where applicable; no compliance assessment is claimed |
| SOC 2 Type II | Control areas to assess; no SOC 2 audit or attestation is claimed |
| HIPAA | Control areas to assess where applicable; no HIPAA certification is claimed |

### Multi-Tenant Isolation

```
Tenant A ──── tenant_id = "tenant-A" ──── [RLS Policy] ──── DB Row A
Tenant B ──── tenant_id = "tenant-B" ──── [RLS Policy] ──── DB Row B
                                                               ↑
                                              Cross-tenant query = BLOCKED (BOLA)
```

### RBAC Roles

| Role | Capabilities |
|---|---|
| super_admin | Full system, cross-tenant metadata |
| legal_counsel | Contract authoring, redlines, approvals |
| procurement_manager | Supplier onboarding, purchase agreements |
| approver | Review and approve/reject requests |
| auditor | Read-only audit trail and reports |
| viewer | Read-only inventory and health summaries |

---

## 15. 400 Enterprise Features

The feature registry lists 400 entries across 20 operational domains. Registry
entries and smoke checks are a catalog, not proof that each capability is
implemented, integrated, or independently tested.

The registry verification checks module metadata and validation before
dispatching to domain-level smoke simulations; it does not execute each
feature module's business behavior. No feature-by-feature implementation or
acceptance audit is established by `npm run test:400`.

| Domain | Features | Description |
|---|---|---|
| Core Contract Repository | 1–47 | Full contract lifecycle, AI intelligence |
| Specialized Agreements | 48–63 | Vendor, Customer, NDA, MSA, SOW, SLA, Employment |
| Legal Operations | 64–83 | ITSM integration, legal matters, outside counsel |
| Document Intelligence | 84–100 | OCR, extraction, comparison, deduplication |
| Advanced Enterprise CLM | 101–120 | Multi-entity, multi-currency, portfolios |
| Section A — Intake | 121–138 | Self-service portal, triage, SLA tracking |
| Section B — Authoring | 139–154 | Conditional assembly, playbooks, fallbacks |
| Section C — Negotiation | 155–168 | External workspace, redline management |
| Section D — Legal Ops | 169–182 | Legal cases, hold management, legal spend |
| Section E — Procurement | 183–201 | Supplier scorecards, diversity, RFPs |
| Section F — Financial | 202–220 | Milestone payments, 3-way match, leakage |
| Section G — Obligations | 221–239 | Evidence tracking, SLA credits, penalties |
| Section H — Risk | 240–259 | Risk register, questionnaires, sanctions |
| Section I — AI Intelligence | 260–284 | NLP Q&A, citations, confidence scoring |
| Section J — Governance | 285–300 | DOA matrix, PoA, segregation of duties |
| Section K — Digital Signing | 301–320 | Tamper-evident bundles, PKI seal |
| Section L — Repository | 321–340 | Folder hierarchy, parent/child, deduplication |
| Section M — Integration | 341–360 | SAP, Oracle, Salesforce, Coupa, ServiceNow |
| Section N — Reporting | 361–375 | Cycle times, bottlenecks, renewal forecast |
| Section O — Security | 376–400 | Multi-tenancy, RBAC/ABAC, audit logs |

---

## 16. Production Requirements

Production requirements depend on which Go services and integrations you enable.
The table lists possible dependencies, not components that have all been
provisioned or verified:

| Requirement | Purpose | Notes |
|---|---|---|
| Go 1.27.3 toolchain | CI and current local validation; modules declare Go 1.26.0 | Required to build Go services |
| PostgreSQL | SaaS persistence | Apply numbered migrations 001–010; Keycloak bootstrap is a separate database concern |
| Keycloak / OIDC | Production identity integration | Configure issuer, clients, keys, and policies before exposure |
| Cloud / CA accounts | Provider-specific functions | Only for integrations enabled and configured in the selected environment |
| Docker / Kubernetes / Terraform | Deployment options | Templates require environment-specific review and validation |
| HSM, Vault, mail, object storage, AI service | Optional integrations | Use only where required by the deployment design; not configured by the demo |

---

## 17. Demo vs Production

Production column values below describe intended integration options, not verified
production capabilities. The Go services require their own configuration and
integration tests; the Node.js mock remains separate.

| Feature | Node.js demo | Go services / production deployment |
|---|---|---|
| Data persistence | In-memory fixture data; resets on restart | PostgreSQL repositories exist; external storage depends on configuration |
| Authentication | Mock endpoint returns a fixed token | JWT/Keycloak integrations require deployment configuration and validation |
| Signatures | Demo UI/mock behavior | Cryptographic packages exist; PKI/HSM and legal compliance are not certified here |
| AI responses | Mock/demo responses | External AI integration requires configuration and safety validation |
| Cloud connectivity | Mock responses | Provider SDK adapters require credentials and live integration tests |
| Certificate issuance | Mock order flow | CA adapters require account configuration and CA-side testing |
| vSatellite certificate deployment | Not performed | Disabled at the gateway command endpoint pending tenant authorization and authenticated transport |
| Startup | `npm start` (local mock server) | Deployment templates require environment-specific implementation |

---

## Contributing

This project uses Kiro AI-assisted development workflows:

```bash
# Feature development
feature: <description>

# Bug fix
bug: <description>

# Plan only (no code changes)
plan: <description>

# Rapid spec generation
spec: <description>
```

Workflow files are in `.kiro/workflows/`. Steering files are in `.kiro/steering/`.

---

## License

UNLICENSED — Enterprise proprietary. All rights reserved.

**M2P Engineering Team** · Built with [Kiro](https://kiro.dev) · Deployed on [Vercel](https://vercel.com)