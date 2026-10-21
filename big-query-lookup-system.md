# Technical Proposal: GCS Object Management via BigQuery Lookup System

**Prepared For:** Application Development Team  
**Objective:** Establish a serverless, metadata-driven file indexing and retrieval system using Google Cloud Storage (GCS) and BigQuery Object Tables linked to Builder.io IDs.

---

## 1. Executive Summary
Traditional cloud storage structures rely on strict file-path naming conventions (prefixes) to simulate folders. This structure breaks down under production loads because changing folder names, avoiding file overwrites, and executing bulk deletions become highly inefficient. 

This proposal outlines a **BigQuery Lookup System** that decouples physical file names from application logic. Files are uploaded under arbitrary or unique identifiers (UUIDs) with a custom metadata tag containing the `builder_id`. **BigQuery Object Tables** automatically index these tags, transforming an unstructured GCS bucket into a fully queryable relational database layer.

```
[Teacher Uploads Folder] ──> [Upload Script adds Metadata] ──> [Stored in GCS Bucket]
                                                                        │
[App Dashboard Request]  <──  [SQL Query Filters by Tag]   <── [BigQuery Object Table]
```

---

## 2. Core Architectural Components

### A. Google Cloud Storage (GCS)
* **Role:** Unstructured object store.
* **Organization:** Flat structure. Files are stored at the root or within a single `/uploads` directory using unique strings (e.g., `4a8f-91b2-c3d4.mp4` or preserving the teacher's original file names).
* **Metadata Layer:** Every object contains a Custom Metadata header: `builder_id: builder_abc123`.

### B. BigQuery Object Table Lookup Index
* **Role:** Managed indexing and metadata cache.
* **Mechanism:** A read-only table linked directly to the GCS bucket. It automatically converts file system attributes (file path, file size, content type) and custom GCS metadata into standard SQL columns.

---

## 3. Operational Workflows

### A. The Upload Workflow
When an application frontend receives a folder or batch of files from a teacher:
1. The backend loops through each file inside the provided directory.
2. The upload payload passes the file data alongside the `builderId` provided by Builder.io.
3. The GCS Client Library writes the file and injects the payload into the `metadata` configuration object.

**Node.js Upload Example:**
```javascript
const { Storage } = require('@google-cloud/storage');
const storage = new Storage();

async function uploadCourseFile(localPath, gcsFilename, builderId) {
  await storage.bucket('my-course-bucket').upload(localPath, {
    destination: `uploads/${gcsFilename}`,
    metadata: {
      metadata: { builder_id: builderId } // Injected as x-goog-meta-builder_id
    }
  });
}
```

### B. The Folder Lookup Workflow
To list or display all files belonging to a specific course folder, the app passes the Builder.io ID to BigQuery via the BigQuery Client Library using standard SQL:

```sql
SELECT 
  uri AS gcs_file_path
FROM 
  `your_gcp_project.your_dataset.your_gcs_object_table`
WHERE 
  JSON_VALUE(metadata.builder_id) = 'builder_abc123';
```

### C. Targeted File Retrieval Workflow (Single File Lookup)
If the application only needs to read a specific configuration file (like `manifest.json`) without downloading heavy media assets, a string filter is added to the GCS `uri` column:

```sql
SELECT 
  uri AS gcs_file_path
FROM 
  `your_gcp_project.your_dataset.your_gcs_object_table`
WHERE 
  JSON_VALUE(metadata.builder_id) = 'builder_abc123'
  AND uri LIKE '%manifest.json';
```

### D. The Deletion Workflow
To delete an entire folder structure cleanly:
1. Query BigQuery for all `uri` values matching the targeted `builder_id`.
2. Map the results into an array of file paths.
3. Send a batch delete command to GCS using the file path array. 

---

## 4. System Trade-offs & Mitigations

### 1. Synchronization Latency
* **Challenge:** BigQuery caches GCS metadata to eliminate query costs. By default, it can take **30 to 60 minutes** for a newly uploaded file or deleted file to reflect in a standard `SELECT` query.
* **Mitigation:** The application backend must explicitly clear the cache immediately after any upload or delete operation finishes by running a cache refresh command:
  ```sql
  CALL BQ.REFRESH_EXTERNAL_METADATA_CACHE('your_project.your_dataset.your_gcs_object_table');
  ```

### 2. Operational Costs
* **GCS Storage:** Free for the first 5 GB; roughly **$0.02 per GB/month** after.
* **BigQuery Storage & Indexing:** Free under the permanent 10 GB Free Tier threshold.
* **BigQuery Queries:** Free for the first **1 TB of data scanned per month**. Because metadata searches only look at text strings (a few kilobytes per query), this layer will remain entirely free (`$0.00`) under standard application usage scale.

---

## 5. Architectural Benefits
* **Zero Database Maintenance:** Eliminates the overhead of provisioning, securing, backing up, and scaling a dedicated PostgreSQL, MySQL, or MongoDB lookup table.
* **Immutable Associations:** Because the ID tag is bound permanently to the file object itself in GCS, data can never desynchronize or become orphaned due to database corruption.
* **Immunity to Naming Collisions:** Teachers can upload files named `syllabus.pdf` across 100 different courses simultaneously. Because BigQuery relies strictly on the `builder_id` metadata tag rather than the file path, files will never overwrite one another.
