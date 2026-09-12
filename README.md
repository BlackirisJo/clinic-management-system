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

Financial reporting is designed to provide visibility into:

* Revenue
* Expenses
* Invoice totals
* Paid amounts
* Outstanding amounts
* Clinic-level financial activity
* Financial KPIs

The reporting architecture is being continuously improved to ensure that financial transactions are correctly reflected across reports and dashboard-level summaries.

---

## Security

Security is treated as a core part of the system rather than a frontend-only feature.

Authorization is enforced on the backend using:

* Authentication
* Role-Based Access Control (RBAC)
* Permissions
* Clinic access control
* Resource-level validation
* Backend request validation

Frontend restrictions are considered a user experience feature only and are **not relied upon as the primary security mechanism**.

Sensitive operations are validated on the server before database changes are performed.

---

## Authentication & Authorization

The system uses authenticated sessions/tokens together with role and permission-based authorization.

Access decisions can depend on:

* User identity
* User role
* Assigned permissions
* Primary clinic
* Additional assigned clinics
* Requested resource
* Target clinic

This architecture is intended to prevent users from bypassing frontend restrictions by directly calling backend APIs.

---

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
│   └── ...
│
├── tests/
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

Environment variables may include configuration for:

* Database connection
* Database credentials
* JWT configuration
* Application ports
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

## Testing

The project includes automated tests covering areas such as:

* Authentication
* Validation
* Users
* Appointments
* Clinical workflows
* Reports
* Integration scenarios

Run the available test suite with:

```bash
npm test
```

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

This project is under active development.

Features, workflows, validations, security controls, financial calculations, and reporting capabilities are continuously being improved.

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
