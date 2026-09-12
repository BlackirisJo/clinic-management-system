# Clinic Management System

A full-stack clinic and medical center management system designed to manage clinical, administrative, financial, and operational workflows in a multi-clinic environment.

## Overview

Clinic Management System is a web-based healthcare management platform built to centralize the daily operations of medical clinics and healthcare centers.

The system provides a structured environment for managing patients, clinics, medical staff, appointments, clinical records, pregnancies, laboratory and imaging workflows, referrals, billing, expenses, reports, and role-based access control.

The project is designed with a focus on:

- Data integrity
- Role-based access control (RBAC)
- Multi-clinic management
- Clinical workflow organization
- Financial management
- Security and access isolation
- Maintainable software architecture

## Main Features

### Patient Management
- Patient registration and management
- Patient medical information
- Patient search and records
- Multi-clinic patient access
- Clinical history

### Clinic Management
- Multiple clinics and specialties
- Clinic staff assignment
- Clinic-specific services
- Clinic-based access control

### Clinical Management
- Medical visits
- Vital signs
- Diagnoses
- Laboratory orders and results
- Medical imaging
- Referrals
- Medical attachments
- Clinical documentation

### Obstetrics & Gynecology
- Pregnancy records
- Pregnancy history
- LMP and EDD
- Gravida / Para / Abortions / Living Children
- Blood group and Rh factor
- Pregnancy risk assessment
- Pregnancy visits
- Fetal heart rate
- Fundal height
- Ultrasound records
- Fetal measurements
- Pregnancy outcomes

### Appointment Management
- Appointment scheduling
- Doctor assignment
- Clinic-based appointments
- Appointment status management

### Billing & Financial Management
- Invoice management
- Invoice items and services
- Clinic services
- Doctor percentage/share calculations
- Payments
- Expenses
- Financial reports
- Financial overview and KPIs

### Reports
- Clinical reports
- Financial reports
- Appointment reports
- Management overview
- Clinic-based reporting

### Security & Access Control
- JWT authentication
- Role-based access control
- Permission-based authorization
- Multi-clinic access isolation
- Central financial access for authorized accounting roles
- Backend authorization enforcement

## Technology Stack

### Frontend
- React
- JavaScript
- Vite
- Modern responsive UI

### Backend
- Node.js
- Express
- TypeScript
- REST API
- Zod validation

### Database
- PostgreSQL
- Database migrations
- Relational data integrity
- Foreign keys and constraints

### Infrastructure
- Docker
- Docker Compose

## Architecture

The project follows a modular architecture separating:

```text
Frontend
   |
   v
REST API
   |
   v
Authentication & Authorization
   |
   v
Business Modules
   |
   v
PostgreSQL
