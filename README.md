Backend modules are organized by business domain rather than placing all functionality in a single application layer.

Security

Security is treated as a core part of the system rather than a frontend-only feature.

Authorization is enforced on the backend using:

Authentication
Roles
Permissions
Clinic access
Resource-level validation

Frontend restrictions are considered a user experience feature only and are not relied upon as the primary security mechanism.

Multi-Clinic Support

The system is designed to support multiple clinics within the same installation.

Users may be assigned to one or more clinics depending on their role and permissions.

Financial roles can be granted centralized access where required, while clinical and operational users remain restricted according to their authorized clinic scope.

Financial Data Integrity

Financial operations are designed to preserve historical invoice values.

Service prices and financial calculations should be validated and calculated on the backend rather than trusting values submitted by the client.

Historical invoices should retain the values used at the time the invoice was issued.

Development Status

This project is under active development.

Features, workflows, validations, security controls, and reporting capabilities are continuously being improved.

Some modules may still require additional testing and production hardening before deployment in a real healthcare environment.

Running the Project
Requirements
Node.js
npm
Docker
Docker Compose
PostgreSQL (when running without Docker)
Clone
git clone https://github.com/BlackirisJo/clinic-management-system.git
cd clinic-management-system
Install Dependencies
npm install

Install frontend dependencies if required:

cd frontend
npm install
cd ..
Environment Configuration

Create the required environment configuration based on the project's environment variables.

Do not commit:

Database passwords
JWT secrets
API keys
Production credentials
Private configuration files
Docker

The project can be run using Docker Compose where supported:

docker compose up -d
Testing

The project includes automated tests covering authentication, validation, clinical workflows, appointments, users, reports, and integration scenarios.

Run the available test suite with:

npm test
Project Goals

The long-term goal is to provide a maintainable and extensible healthcare management platform capable of supporting:

Small medical clinics
Multi-specialty clinics
Medical centers
Multiple departments
Centralized administration
Financial management
Clinical workflows

while maintaining strong data integrity, security, and separation between clinical and administrative responsibilities.

License

This project is currently maintained as a private/open-source development project.

License information will be added when the project's distribution terms are finalized.
