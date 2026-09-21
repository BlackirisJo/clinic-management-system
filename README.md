# Clinic Management System

A full-stack healthcare management platform designed to support medical clinics, multi-specialty centers, clinical workflows, patient management, appointments, billing, financial operations, reporting, and role-based access control.

The system is designed with a strong focus on **security, data integrity, modularity, and multi-clinic architecture**.

---

## Overview

The **Clinic Management System** is a web-based healthcare management platform intended to centralize clinical and administrative operations within a single system.

The architecture is designed to support different types of healthcare facilities, from individual clinics to multi-specialty medical centers with multiple departments and centralized administrative functions.

The system separates clinical responsibilities from administrative and financial operations through backend-enforced authentication, authorization, permissions, and clinic-level access control.

---

## Key Features

### Patient Management

* Patient registration and management
* Patient demographic information
* Patient medical information
* Multi-clinic patient access
* Patient search and retrieval
* Clinical history management
* Patient-related documents and attachments

### Clinic Management

* Multiple clinic support
* Clinic registration and configuration
* Clinic activation/deactivation
* Clinic staff assignment
* Role-based clinic access
* Centralized administrative management

### Clinical Management

The clinical module is designed to support multiple medical specialties and workflows.

Current specialty coverage includes:

* Emergency Medicine
* General / Family Medicine
* Internal Medicine
* Pediatrics
* Obstetrics & Gynecology
* Cardiology
* Dermatology
* Orthopedics
* Ophthalmology
* ENT
* Dentistry
* Urology
* Surgery
* Neurology
* Psychiatry
* Physiotherapy
* Nutrition

Clinical functionality includes:

* Patient visits
* Vital signs
* Diagnoses
* Laboratory orders and results
* Medical imaging
* Referrals
* Clinical attachments
* Clinical documentation

### Emergency Medical Report

The Emergency Medical Report (`POST /api/clinical/emergency-report`) generates a comprehensive print-ready report for a patient across all clinics with medical data. It includes:

* Patient demographics
* Report metadata (generator name, role, specialty, clinic, timestamp)
* Medical profile, allergies, chronic conditions
* Pregnancy status with visits, labs, ultrasounds
* Per-clinic visit data with vitals, diagnoses, lab orders, imaging, referrals, prescriptions, and attachments
* Access is gated by the `GENERATE_EMERGENCY_REPORT` permission; authorized users discover all clinics with records for the patient

### Unified Medical Record

The Unified Medical Record tab on the patient detail page aggregates visits, prescriptions, diagnoses, lab results, imaging, referrals, and attachments across all authorized clinics into a single view, respecting patient-sharing and clinic-scope rules.

---

### Obstetrics & Gynecology

The system includes a dedicated pregnancy-care workflow with support for:

* Pregnancy records
* Last Menstrual Period (LMP)
* Estimated Due Date (EDD)
* Gravida / Para / Abortions / Living Children
* Blood group and Rh factor
* Pregnancy risk classification
* Risk factors
* Pregnancy visits
* Gestational age
* Fetal heart rate
* Fundal height
* Ultrasound records
* Fetal measurements
* Pregnancy outcomes
* Delivery information

---

## Appointments

Appointment management includes:

* Appointment creation
* Patient scheduling
* Doctor assignment
* Clinic-based scheduling
* Appointment status management
* Validation of appointment data
* Clinic-level authorization

---

## Billing & Financial Management

The financial module is designed to manage clinic-related financial operations.

Access to billing features is permission-based: users see billing/reports navigation only when holding the relevant permissions (`VIEW_INVOICES` for billing, `VIEW_REPORTS` for reports). Role assignments alone do not determine visibility.

### Services

* Clinic service management
* Service pricing
* Doctor percentage configuration
* Clinic-specific services
* Centralized financial administration

### Invoices

The billing system is designed around an invoice-based model where an invoice acts as the parent financial document and its services are maintained as invoice items.

Invoice information can include:

* Invoice number
* Patient
* Clinic
* Doctor
* Invoice date
* Services / invoice items
* Service quantities
* Service prices
* Discounts where applicable
* Total amount
* Paid amount
* Outstanding amount
* Invoice status

Historical invoice values are intended to remain independent from future changes to service pricing.

All invoice operations are protected by backend permission checks (`CREATE_INVOICE`, `VIEW_INVOICES`, `VIEW_FINANCIAL_REPORTS`) and clinic/data scope — a user can only access invoices for clinics within their scope.

### Expenses

The system supports:

* Expense creation
* Expense categorization
* Clinic-specific expenses
* Expense descriptions
* Financial reporting
* Centralized financial access

---

## Reports & Financial Overview

The system includes reporting functionality for clinical and financial operations.

Reports navigation is gated by the `VIEW_REPORTS` permission. Role assignments alone do not determine visibility.

Financial reporting is designed to provide visibility into:

* Revenue
* Expenses
* Invoice totals
* Paid amounts
* Outstanding amounts
* Clinic-level financial activity
* Financial KPIs

Report access is protected by backend permission checks (`VIEW_REPORTS`) and clinic/data scope — users can only see data from clinics within their authorized scope.

The reporting architecture is being continuously improved to ensure that financial transactions are correctly reflected across reports and dashboard-level summaries.

---

## Security

Security is treated as a core part of the system rather than a frontend-only feature.

Authorization is enforced on the backend using:

* Authentication (JWT with JTI-based session tracking)
* Role-Based Access Control (RBAC)
* Permissions (granular, e.g. `GENERATE_EMERGENCY_REPORT`, `MANAGE_CLINICAL_DATA`, `MANAGE_PREGNANCY`)
* Clinic access control (per-user clinic scope or global admin override)
* Resource-level validation
* Backend request validation (Zod schemas)
* Audit logging of sensitive operations

Feature visibility in the frontend (navigation tabs, buttons, forms) is driven by permissions where applicable (e.g. `VIEW_INVOICES`, `VIEW_REPORTS`, `MANAGE_SERVICES`, `CREATE_INVOICE`), not by role names. Unintended `roleName`-based authorization bypasses in finance authorization have been removed — access is determined by permissions and clinic/data scope.

Frontend restrictions are considered a user experience feature only and are **not relied upon as the primary security mechanism**.

Sensitive operations are validated on the server before database changes are performed.

---

## Authentication & Authorization

The system uses JWT tokens with JTI (unique token identifier) session tracking and server-side session validation.

Access decisions can depend on:

* User identity
* User role
* Assigned permissions
* Primary clinic
* Additional assigned clinics
* Requested resource
* Target clinic

Session lifecycle:

* Tokens carry a `jti` verified against `user_sessions` on every request
* Sessions can be revoked individually or in bulk
* Revoked tokens and expired sessions return `403` (`SESSION_REVOKED`)
* Tokens without a `jti` return `403` (`INVALID_SESSION`)
* Password changes revoke all other active sessions
* IP addresses are recorded at login for session auditing

This architecture is intended to prevent users from bypassing frontend restrictions by directly calling backend APIs.

---

## Audit / System Logs

Sensitive operations are recorded in `audit_logs` across all modules including authentication, user management, clinics, patients, billing, visits, prescriptions, backups, pregnancies, and emergency reports. Each entry captures:

* User ID and clinic ID
* Action type (e.g. `LOGIN_SUCCESS`, `LOGIN_FAILURE`, `LOGIN_BLOCKED`, `EMERGENCY_REPORT_GENERATED`)
* Resource type and ID
* Metadata (context-specific details as JSON)

## Multi-Clinic Support

The system is designed to support multiple clinics within the same installation.

Users may be assigned to one or more clinics depending on their role and permissions.

Clinical and operational users can remain restricted to their authorized clinic scope, while centralized administrative or financial roles can be granted broader access where required.

This allows the same installation to support:

* Independent clinics
* Multi-specialty medical centers
* Multiple departments
* Centralized financial operations
* Centralized administration

---

## Financial Data Integrity

Financial operations are designed to preserve historical invoice values.

Service prices and financial calculations should be validated and calculated on the backend rather than trusting values submitted by the client.

Historical invoices should retain the values used at the time the invoice was issued.

This is important because changing the current price of a medical service should not retroactively change previously issued invoices.

Financial calculations should therefore distinguish between:

* Current service configuration
* Historical invoice item values
* Invoice totals
* Payments
* Outstanding balances
* Doctor/service revenue shares

---

## Data Validation

The backend uses schema-based request validation to reduce invalid or malformed data entering the system.

Validation is applied to areas such as:

* Authentication
* Users
* Patients
* Appointments
* Clinical records
* Pregnancy records
* Billing
* Services
* Expenses
* Reports

Backend validation remains the authoritative validation layer.

---

## Architecture

The project follows a modular full-stack architecture.

### Frontend

The frontend is responsible for:

* User interface
* Navigation
* Forms
* Data presentation
* Client-side validation
* Authentication state
* API communication

### Backend

The backend provides:

* REST APIs
* Authentication
* Authorization
* Business logic
* Validation
* Financial calculations
* Clinical workflows
* Database access

### Database

PostgreSQL is used as the primary relational database.

The database stores:

* Users
* Roles
* Permissions
* Clinics
* Clinic staff
* Patients
* Visits
* Diagnoses
* Laboratory data
* Imaging
* Referrals
* Pregnancy records
* Appointments
* Services
* Invoices
* Invoice items
* Expenses
* Reports and related financial data

---

## Technology Stack

### Frontend

* React
* JavaScript
* Vite

### Backend

* Node.js
* Express
* TypeScript
* REST API
* Zod

### Database

* PostgreSQL

### Infrastructure

* Docker
* Docker Compose

### Development

* Git
* GitHub
* VS Code

---

## Project Structure

A simplified representation of the project structure:

```text
clinic-management-system/
│
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   ├── views/
│   │   ├── lib/
│   │   └── ...
│   │
│   └── ...
│
├── src/
│   ├── modules/
│   │   ├── auth/
│   │   ├── users/
│   │   ├── clinics/
│   │   ├── patients/
│   │   ├── clinical/
│   │   ├── appointments/
│   │   ├── billing/
│   │   └── ...
│   │
│   ├── middlewares/
│   ├── migrations/
│   ├── specialties/
│   ├── tests/
│   └── ...
│
├── docker-compose.yml
├── package.json
└── README.md
```

The exact structure may evolve as the project continues to develop.

---

## Running the Project

### Requirements

Make sure the following are installed:

* Node.js
* npm
* Docker
* Docker Compose
* PostgreSQL — only required when running the database without Docker

---

### Clone

```bash
git clone https://github.com/BlackirisJo/clinic-management-system.git
cd clinic-management-system
```

---

### Install Backend Dependencies

```bash
npm install
```

---

### Install Frontend Dependencies

```bash
cd frontend
npm install
cd ..
```

---

## Environment Configuration

Create the required environment configuration based on the project's environment variables.

A ready-to-copy template is provided at `.env.example` (backend root) and `frontend/.env.example`:

```bash
cp .env.example .env        # then fill in real values
cp frontend/.env.example frontend/.env
```

Environment variables may include configuration for:

* Database connection (`DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`)
* JWT configuration (`JWT_SECRET`)
* Application ports (`PORT`) and CORS (`CORS_ORIGIN`)
* Seed defaults (`ADMIN_USERNAME`, `ADMIN_INITIAL_PASSWORD`)
* Encrypted backups (`BACKUP_ENCRYPTION_KEY`, `BACKUP_DIR`, `BACKUP_RETENTION_DAYS`)
* External services
* API configuration

### Never commit sensitive configuration

Do not commit:

* Database passwords
* JWT secrets
* API keys
* Production credentials
* Private certificates
* `.env` files containing secrets

Use environment variables or a secure secrets-management solution instead.

### Runtime requirements

* **PostgreSQL >= 16** (the `ALTER TABLE IF EXISTS` and exclusion-constraint migrations rely on it).
* **Backups**: the encrypted backup feature shells out to `pg_dump`/`psql`. The Docker image already installs `postgresql-client`; on bare-metal hosts install the PostgreSQL client tools, otherwise `POST /api/backups` responds with a clear `503`. Each backup writes a sibling `<file>.enc.meta.json` (iv, auth_tag, checksum, size, database, created_at) so a backup stays restorable even if the database itself is lost — keep these files together with the `.enc` files.
* **Password rotation**: users change their own password via `POST /api/auth/change-password`; on success all other sessions are revoked and `is_force_password_change` is cleared.

---

## Docker

The project can be run using Docker Compose where supported.

Start the containers with:

```bash
docker compose up -d
```

To view running containers:

```bash
docker compose ps
```

To view application logs:

```bash
docker compose logs -f
```

To stop the environment:

```bash
docker compose down
```

---

## Database

PostgreSQL is used as the primary database.

When running through Docker Compose, the database is managed as part of the containerized development environment.

Database migrations are maintained within the project and should be applied according to the project's deployment workflow.

**Production databases should always be backed up before applying schema changes or migrations.**

---

## i18n — Arabic / English with RTL/LTR

The frontend supports bilingual operation with automatic layout direction:

* **Arabic (`ar`)** — default language, RTL layout (`dir="rtl"`)
* **English (`en`)** — LTR layout (`dir="ltr"`)
* Language switcher in the UI (`lang.switchLabel`)
* Selection persisted to `localStorage` (`clinic_lang`)
* `document.documentElement.lang` and `dir` updated on every language change
* All user-facing strings externalized to locale dictionaries (`en.js`, `ar.js`) — no hardcoded UI text
* Formatters (dates, numbers, currency) respect the active locale

---

## Testing

The project includes automated tests covering areas such as:

* Authentication and session management
* RBAC and permission enforcement
* Cross-clinic authorization and patient sharing
* Financial calculations and invoice integrity
* Clinical workflows and pregnancy care
* Validation and data integrity
* Integration scenarios

Run the available test suite with:

```bash
npm test
```

Current results (as of the latest run): 163 passed, 0 failed, 31 skipped (integration tests requiring a running Docker environment).

Additional tests should be added as new modules and security-sensitive workflows are introduced.

Particular attention should be given to:

* Cross-clinic authorization
* Financial calculations
* Patient access control
* Role and permission enforcement
* Historical invoice integrity
* API validation

---

## Development Principles

The project follows several development principles:

### Backend-First Security

Security-sensitive decisions must be enforced by the backend.

### Explicit Authorization

Users should only access resources they are authorized to access.

### Data Integrity

Financial and clinical records should maintain relational and historical integrity.

### Separation of Responsibilities

Clinical, administrative, and financial responsibilities should remain appropriately separated through roles and permissions.

### Modular Architecture

Business domains are organized into modules to make the system easier to maintain and extend.

### Minimal and Controlled Changes

Changes to existing functionality should avoid unnecessary architectural disruption and should preserve existing data whenever possible.

---

## Production Considerations

This project is currently under active development and should not be considered production-ready for a real healthcare environment without additional review and hardening.

Before production deployment, additional work may be required in areas including:

* Comprehensive security auditing
* Penetration testing
* Database backup and recovery procedures
* Audit logging
* Encryption and key management
* File upload security
* Malware scanning
* Secrets management
* Monitoring and alerting
* Rate limiting
* Infrastructure hardening
* Disaster recovery
* Privacy and regulatory compliance
* Comprehensive automated testing
* High-availability architecture where required

Healthcare deployments should also be evaluated against the applicable legal, privacy, security, and regulatory requirements of the target jurisdiction.

---

## Development Status

This project is under active development with the following core areas fully implemented and verified:

**Implemented:**

* JWT/JTI authentication with session tracking and revocation
* RBAC with granular permissions
* Audit logging across all modules
* Patient sharing and cross-clinic medical access
* Unified medical record view
* Pregnancy full workflow (records, visits, ultrasounds, lab orders, results)
* Emergency Medical Report generation
* i18n (Arabic/English) with RTL/LTR support
* Clinical workflows (visits, vitals, diagnoses, lab orders, imaging, referrals, prescriptions, attachments)
* Billing, invoices, expenses, and financial reporting
* Appointments
* Database migrations with clinic-scoped data integrity

**Planned/Future:**

* Expanded specialty-specific clinical workflows
* Enhanced financial reporting
* Advanced invoice management
* Enhanced audit logging
* Expanded automated test coverage
* Stronger file and attachment security
* Enhanced reporting dashboards
* Improved database integrity constraints
* Advanced appointment workflows
* Performance optimization
* Production deployment hardening
* Backup and disaster-recovery workflows

The project is being developed with the goal of evolving from a functional healthcare management application into a maintainable and extensible platform.

Some modules may still require additional testing, security review, performance optimization, and production hardening before deployment in a real healthcare environment.

---

## Project Goals

The long-term goal is to provide a maintainable and extensible healthcare management platform capable of supporting:

* Small medical clinics
* Multi-specialty clinics
* Medical centers
* Multiple departments
* Centralized administration
* Financial management
* Clinical workflows
* Multi-clinic operations

while maintaining strong:

* Data integrity
* Security
* Maintainability
* Scalability
* Separation of responsibilities
* Auditability

---

## Roadmap

Planned improvements may include:

* Expanded specialty-specific clinical workflows
* Enhanced financial reporting
* Advanced invoice management
* Improved audit logging
* Expanded automated test coverage
* Stronger file and attachment security
* Enhanced reporting dashboards
* Improved database integrity constraints
* Advanced appointment workflows
* Performance optimization
* Production deployment hardening
* Backup and disaster-recovery workflows

The roadmap may change as the project evolves.

---

## Contributing

The project is currently under active development.

Before contributing significant changes:

1. Review the existing architecture.
2. Understand the relevant module and database relationships.
3. Preserve existing data integrity.
4. Avoid bypassing backend authorization.
5. Add or update tests for behavioral changes.
6. Keep changes focused and maintainable.
7. Document important architectural or database changes.

---

## Repository

GitHub:

https://github.com/BlackirisJo/clinic-management-system

---

## License

This project does not currently specify a finalized open-source license.

Until a license is explicitly added to the repository, the source code should not be assumed to be freely redistributable, modified, or used commercially.

License information will be added when the project's distribution terms are finalized.
