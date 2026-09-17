# Quality Monitoring App — Product Requirements Document (PRD)

**Version:** 1.0
**Project:** Quality Monitoring App
**Purpose:** Digitize and monitor periodic quality checks in manufacturing operations.

---

## 1. Product Overview

The Quality Monitoring App is a digital quality-check monitoring system for manufacturing operations.

The system will replace or reduce manual monitoring of periodic quality checks performed on machines by quality/production workers.

The application will:

* Notify workers when a quality check is due.
* Show the machine/check assigned to the worker.
* Require the worker to capture a live photo using the mobile camera.
* Prevent selecting an existing photo from the gallery.
* Allow the worker to submit quality-check parameters.
* Provide an **Exception** workflow when the scheduled check cannot be performed.
* Track completed, missed, pending, and exception checks.
* Provide an Admin Web Panel for configuration, monitoring, and reporting.
* Keep the system configurable so that new machines, activities, parameters, schedules, and workers can be added without modifying application code.
* Be designed for future integration with the company's QMS.

---

# 2. Problem Statement

Currently, quality checks may require quality personnel to physically visit machines at regular intervals.

Examples of checks include:

* Viscosity
* Repeat Length
* Corona Treatment
* TEAP Test
* Deep Punching
* Registration
* Print Prachar
* Other company-defined quality parameters

The main problems are:

1. Checks can be missed.
2. Management may not have real-time visibility of missed checks.
3. Manual records are difficult to track.
4. Old photos or incorrect evidence may potentially be submitted.
5. Quality-check schedules may change according to machine/process requirements.
6. There is no centralized digital history of all checks.

The application must make the process simple for workers and difficult to misuse.

---

# 3. Product Goals

## Primary Goals

### G1 — Digital Quality Monitoring

Convert periodic manual quality checks into a digital workflow.

### G2 — Live Evidence

Every applicable quality check must have live photographic evidence captured from the mobile camera.

### G3 — Missed Check Tracking

The system must identify:

* Completed checks
* Pending checks
* Missed checks
* Exception checks

### G4 — Configurable Quality Checks

Administrators must be able to configure:

* Machines
* Activities
* Parameters
* Frequency
* Schedule
* Workers
* Shifts
* Acceptance criteria

without requiring code changes.

### G5 — Future QMS Integration

The system architecture must allow future integration with the company's QMS.

---

# 4. Users and Roles

## 4.1 Worker

The worker performs scheduled quality checks.

Worker can:

* Login
* View assigned machines/checks
* Receive notifications
* Open scheduled check
* Capture live photo
* Enter quality parameter values
* Submit check
* Raise an exception
* Provide exception reason
* Capture exception evidence
* View own check history

Worker should not be able to:

* Upload gallery photos
* Modify submitted records
* Change check schedules
* Change parameter configuration
* Access other workers' records unless explicitly permitted

---

## 4.2 Admin

Admin manages the system.

Admin can:

* Manage workers
* Manage machines
* Manage activities
* Manage quality parameters
* Configure schedules
* Configure frequency
* Assign workers
* Configure shifts
* Configure acceptance criteria
* View all checks
* View missed checks
* View exceptions
* View reports
* Download reports

---

## 4.3 Manager / Quality Manager

Manager has monitoring and reporting access.

Manager can:

* View quality-check status
* Monitor worker performance
* View missed checks
* View exceptions
* View historical records
* View reports
* Filter data by date, machine, worker, parameter, and status

Configuration permissions may be restricted to Admin.

---

# 5. Core Worker Workflow

The worker workflow must remain extremely simple.

```text
Notification
     ↓
Open App
     ↓
View Due Check
     ↓
Select Machine / Check
     ↓
┌──────────────────────┐
│  Click Image         │
│  Exception           │
└──────────────────────┘
     ↓
Perform Check
     ↓
Capture Live Photo
     ↓
Enter Parameter Values
     ↓
Submit
     ↓
Check Completed
```

---

# 6. Notification System

The system must notify workers when a scheduled quality check becomes due.

Example:

> Quality Check Due
> Machine: Printing Machine 01
> Check: Routine Quality Check
> Parameters: Viscosity, Registration
> Please perform the check now.

Notifications must be generated according to the configured schedule.

The system should support:

* Scheduled notifications
* Worker-specific notifications
* Machine-specific schedules
* Shift-based schedules
* Activity-based schedules

Workers must not receive checks outside their assigned working schedule unless explicitly configured.

---

# 7. Quality Check Workflow

When the worker opens a due check:

### Step 1 — Machine

Display the assigned machine.

Example:

```text
Printing Machine 01
```

### Step 2 — Quality Activity

Example:

```text
Routine Printing Quality Check
```

### Step 3 — Parameters

Display the parameters configured for that activity.

Example:

```text
Viscosity
Repeat Length
Registration
Print Prachar
```

### Step 4 — Live Evidence

Worker selects:

```text
Click Image
```

The application opens the device camera.

The worker must capture a new image.

Gallery/library selection must not be provided as an upload option.

### Step 5 — Parameter Form

Worker enters the required values/results.

Example:

```text
Viscosity: ______ sec

Repeat Length: ______ mm

Registration: Pass / Fail

Print Prachar: Pass / Fail
```

### Step 6 — Submit

Worker submits the completed check.

Backend stores:

* Worker
* Machine
* Activity
* Parameters
* Values
* Status
* Timestamp
* Photo path
* Exception information, if applicable

---

# 8. Live Photo Requirement

This is a critical requirement.

## Required

Photo must be captured using the mobile device camera during the check workflow.

## Not Allowed

The worker must not be able to:

* Select a photo from Gallery
* Select an old photo from Library
* Upload an arbitrary image file

## Important Technical Requirement

The frontend restriction alone is not considered sufficient security.

The backend should validate the upload workflow as much as technically possible.

The system should also record:

* Capture/submission timestamp
* Worker ID
* Machine ID
* Check ID
* File path
* File metadata where useful

The system should maintain an audit trail.

---

# 9. Exception Workflow

If a worker cannot perform the scheduled check, the worker can select:

```text
Exception
```

Examples:

* Machine stopped
* Machine under maintenance
* Worker unavailable
* Material unavailable
* Production stopped
* Other approved reason

Workflow:

```text
Exception
    ↓
Select Reason
    ↓
Enter Remark
    ↓
Capture Live Photo
    ↓
Submit Exception
```

Example:

```text
Reason:
Machine stopped

Remark:
Machine is under maintenance.

Photo:
[Live captured image]

[Submit Exception]
```

Exception submission must not automatically be treated as a completed quality check.

Its status should remain:

```text
EXCEPTION
```

---

# 10. Quality Parameter System

Quality parameters must be configurable.

Initial parameters include:

1. Viscosity
2. Repeat Length
3. Corona Treatment
4. TEAP Test
5. Deep Punching
6. Registration
7. Print Prachar

These are initial examples and must not be hard-coded as the only available parameters.

The Admin should be able to add new parameters.

---

# 11. Parameter Types

The system should support multiple parameter types.

## Numeric

Example:

```text
Viscosity
Value: 18
Unit: sec
```

## Pass / Fail

Example:

```text
Registration
Result: Pass
```

## Dropdown

Example:

```text
Corona Treatment
Result:
38 Dyne
40 Dyne
42 Dyne
```

## Text

Example:

```text
Observation:
________________
```

## Photo

Parameter/activity may require photographic evidence.

---

# 12. Acceptance Criteria

Parameters may have configurable acceptance criteria.

Example:

```text
Parameter: Viscosity

Minimum: 18
Maximum: 22
Unit: sec
```

The system can automatically determine:

```text
18–22 → PASS

Below 18 → FAIL

Above 22 → FAIL
```

Acceptance rules must be configurable by Admin.

The exact limits must come from company-approved quality specifications/SOPs.

The application must not invent quality limits.

---

# 13. Configurable Scheduling

Admin must be able to configure:

* Frequency
* Start time
* End time
* Shift
* Machine
* Activity
* Parameter
* Worker/team assignment

Examples:

```text
Every 30 minutes
Every 1 hour
Every 2 hours
Shift-wise
Daily
Custom schedule
```

Example:

```text
Machine:
Printing Machine 01

Activity:
Routine Quality Check

Frequency:
Every 30 minutes

Shift:
08:00 – 16:00

Assigned Worker:
Worker A
```

---

# 14. Shift Management

Admin can create shifts.

Example:

```text
Shift A
08:00 – 16:00

Shift B
16:00 – 00:00

Shift C
00:00 – 08:00
```

The system should generate/check scheduled tasks only within the configured working period.

Workers should not receive unnecessary notifications after their assigned shift ends.

---

# 15. Check Status

Every scheduled check should have a clear status.

Possible statuses:

```text
PENDING
DUE
IN_PROGRESS
COMPLETED
MISSED
EXCEPTION
FAILED
```

Example:

```text
10:00 → COMPLETED
10:30 → COMPLETED
11:00 → MISSED
11:30 → EXCEPTION
12:00 → PENDING
```

---

# 16. Admin Dashboard

Dashboard should provide an overview of quality monitoring.

## Main KPIs

* Total Scheduled Checks
* Completed
* Pending
* Missed
* Exceptions
* Failed Checks
* Completion Rate

Example:

```text
Today's Quality Monitoring

Scheduled       120
Completed       105
Pending           5
Missed            6
Exceptions        4
```

---

# 17. Monitoring Dashboard

Admin/Manager should be able to filter:

* Date
* Shift
* Machine
* Worker
* Activity
* Parameter
* Status

Example:

```text
Date: 15 Sep 2026
Machine: Printing Machine 01
Worker: Worker A
Status: Missed
```

The system should show the relevant record.

---

# 18. Missed Check Monitoring

The system must clearly identify workers who fail to complete checks within the configured time window.

Example:

```text
MISSED CHECK

Worker: Worker A
Machine: Printing Machine 02
Check: Viscosity
Scheduled: 11:30 AM
Status: MISSED
```

Management should be able to identify repeated missed checks.

---

# 19. Worker History

Worker can view their own previous records.

Example:

```text
15 Sep

10:00
Printing Machine 01
Completed

10:30
Printing Machine 01
Completed

11:00
Printing Machine 01
Exception

11:30
Printing Machine 01
Completed
```

Worker should not be able to modify historical submitted records.

---

# 20. Reporting

Admin/Manager should be able to generate reports.

Reports should support filters such as:

* Date range
* Machine
* Worker
* Shift
* Activity
* Parameter
* Status

Reports should include:

* Scheduled checks
* Completed checks
* Missed checks
* Exceptions
* Failed checks
* Parameter values
* Submission timestamps
* Worker information
* Machine information
* Photo evidence reference

Export formats:

* CSV
* Excel
* PDF

---

# 21. Photo Storage — MVP

For the initial development/MVP version, uploaded photos will be stored on the local backend PC.

Recommended structure:

```text
backend/
│
├── uploads/
│   ├── quality-checks/
│   │   └── YYYY-MM-DD/
│   │
│   └── exceptions/
│       └── YYYY-MM-DD/
│
└── src/
```

Example:

```text
uploads/
quality-checks/
2026-09-15/
check_001.jpg
check_002.jpg
```

The database should store the file path/reference rather than storing the image binary directly.

Example:

```text
photo_path:
uploads/quality-checks/2026-09-15/check_001.jpg
```

---

# 22. Future Storage

The application should be designed so that local storage can later be replaced by:

* Company file server
* MinIO
* S3-compatible storage
* Other approved company storage

The storage implementation should be separated from business logic.

Example conceptual interface:

```text
Storage Service
      ↓
Local Storage
      OR
MinIO
      OR
S3
```

This prevents major backend changes when storage is migrated.

---

# 23. Technology Stack

## Mobile Application

**React Native + Expo + TypeScript**

Used for:

* Worker mobile application
* Camera
* Notifications
* Forms
* API communication

---

## Admin Web

**React + TypeScript + Tailwind CSS**

Used for:

* Dashboard
* Configuration
* Monitoring
* Reports
* User management

---

## Backend

**Node.js + Express + TypeScript**

Used for:

* REST APIs
* Authentication
* Business logic
* Scheduling
* Quality-check processing
* File uploads
* Reporting

---

## Database

**PostgreSQL**

Used for:

* Users
* Roles
* Machines
* Activities
* Parameters
* Schedules
* Shifts
* Quality checks
* Exceptions
* Audit records

---

## Notifications

**Mobile native notifications through Expo Notifications / Firebase Cloud Messaging where required.**

The worker receives a normal Android notification.

---

## Storage — Initial MVP

**Local backend `uploads/` folder**

Future:

**MinIO / S3-compatible company storage**

---

# 24. High-Level System Architecture

```text
                    ┌──────────────────────┐
                    │    Admin Web App     │
                    │ React + TypeScript   │
                    └──────────┬───────────┘
                               │
                               │ REST API
                               ▼
┌──────────────────┐    ┌──────────────────────┐
│ Worker Mobile App│───▶│ Node.js + Express    │
│ Expo + React     │    │ TypeScript Backend   │
│ Native Camera    │    └──────────┬───────────┘
│ Notifications    │               │
└──────────────────┘               │
                         ┌─────────┴─────────┐
                         ▼                   ▼
                  ┌──────────────┐    ┌──────────────┐
                  │ PostgreSQL   │    │ uploads/     │
                  │ Database     │    │ Local Photos │
                  └──────────────┘    └──────────────┘
```

---

# 25. Suggested Database Entities

Initial database entities:

```text
users
roles
machines
departments
activities
parameters
parameter_options
shifts
schedules
assignments
quality_checks
quality_check_values
exceptions
photos
notifications
audit_logs
```

Relationships should be designed so one activity can contain multiple parameters.

Example:

```text
Machine
   ↓
Activity
   ↓
Multiple Parameters
   ↓
Scheduled Check
   ↓
Worker Submission
   ↓
Photo Evidence
```

---

# 26. Authentication and Authorization

The system must implement role-based access control.

Example roles:

```text
WORKER
ADMIN
MANAGER
```

Requirements:

* Secure login
* Password hashing
* JWT authentication
* Refresh token mechanism
* Protected APIs
* Role-based authorization
* Worker can access only permitted data
* Admin can access configuration
* Manager can access monitoring/reporting according to permissions

---

# 27. Audit Trail

Important actions should be logged.

Examples:

* Login
* Parameter created
* Parameter updated
* Schedule changed
* Worker assigned
* Quality check submitted
* Exception submitted
* Record viewed
* Configuration changed

Audit record should contain:

```text
User
Action
Entity
Timestamp
Old Value
New Value
```

where applicable.

---

# 28. API Requirements

Backend should expose REST APIs.

Example API groups:

```text
/api/auth
/api/users
/api/machines
/api/activities
/api/parameters
/api/shifts
/api/schedules
/api/assignments
/api/quality-checks
/api/exceptions
/api/photos
/api/reports
/api/notifications
```

The API design must be modular and maintainable.

---

# 29. Non-Functional Requirements

## Reliability

A submitted quality check must not be silently lost.

## Security

Workers must not access unauthorized records.

## Performance

Common dashboard/API requests should respond quickly under normal factory usage.

## Maintainability

The system must use modular architecture.

## Configurability

Business rules should not be unnecessarily hard-coded.

## Scalability

Architecture should allow future expansion to more:

* Machines
* Workers
* Departments
* Parameters
* Activities
* Plants

---

# 30. Mobile UX Requirements

The worker interface must be extremely simple.

Avoid:

* Information-heavy screens
* Complicated navigation
* Large forms
* Unnecessary text
* Complex configuration options

Prioritize:

* Large buttons
* Clear status
* Simple instructions
* Camera-first workflow
* Minimal typing
* Clear error messages

Primary worker actions should be obvious:

```text
CHECK NOW
EXCEPTION
SUBMIT
```

---

# 31. Admin UX Requirements

Admin interface can be more information-rich.

Main navigation:

```text
Dashboard
Machines
Activities
Parameters
Schedules
Workers
Shifts
Quality Checks
Exceptions
Reports
Audit Logs
Settings
```

Admin should have a calendar/date-based view for scheduled quality checks.

---

# 32. MVP Scope

The first MVP should include:

### Worker Mobile

* Login
* Today's checks
* Notification
* Machine/check selection
* Camera capture
* Parameter form
* Submit
* Exception
* Exception photo
* Worker history

### Admin Web

* Login
* Dashboard
* Worker management
* Machine management
* Parameter management
* Activity management
* Schedule configuration
* Shift configuration
* Worker assignment
* Quality-check monitoring
* Missed-check monitoring
* Exception monitoring
* Basic reports

### Backend

* Authentication
* PostgreSQL database
* REST APIs
* Quality-check APIs
* Exception APIs
* Schedule system
* Notification system
* Local photo upload
* Audit logging

---

# 33. Out of Scope for Initial MVP

The following should not be implemented initially unless specifically required:

* AI-based image quality detection
* Automatic OCR
* Automatic visual defect detection
* QMS integration
* SAP integration
* Cloud image storage
* Advanced analytics
* Predictive quality analysis
* Machine/PLC integration

These can be future phases.

---

# 34. Future Roadmap

## Phase 1 — MVP

Core quality monitoring.

## Phase 2 — Advanced Monitoring

* Better analytics
* Quality trends
* Worker performance
* Machine-wise quality trends
* Advanced reports

## Phase 3 — QMS Integration

Connect the application with the company's QMS.

Potential future flow:

```text
Quality Monitoring App
          ↓
       QMS
          ↓
CAPA / NCR / Corrective Action
          ↓
Quality Management
```

## Phase 4 — Smart Quality

Potential future capabilities:

* AI image analysis
* Automatic defect detection
* OCR
* Predictive quality alerts
* Machine/PLC/IoT integration

---

# 35. Success Criteria

The MVP will be considered successful when:

1. Worker receives the scheduled notification.
2. Worker can open the assigned quality check.
3. Worker can capture a live image using the camera.
4. Gallery upload is not available in the normal workflow.
5. Worker can enter required quality parameters.
6. Worker can submit the check successfully.
7. Photo is stored in the backend `uploads/` folder.
8. Photo path is stored in PostgreSQL.
9. Admin can see the submitted check.
10. Admin can identify missed checks.
11. Worker can submit an exception with evidence.
12. Admin can configure parameters and schedules.
13. Workers do not receive checks outside configured working periods.
14. The system maintains an audit trail.
15. The architecture can later migrate from local storage to MinIO/S3 and integrate with QMS.

---

# 36. Key Principle

The application must follow one core principle:

> **The worker should only need to perform the quality check; the system should handle scheduling, evidence collection, tracking, and reporting automatically.**

The system must be **simple for workers, configurable for Admins, and auditable for management.**
