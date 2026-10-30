# Field encryption and key management (H4)

Migration `0027_sites_privacy_encryption.sql`. Applies to the highest-risk personal data
held in plain columns: **national ID / resident card / passport numbers**
(`profiles.id_no`) and **company bank IBANs** (`companies.iban`).

## What is stored

| Column | Holds |
|---|---|
| `profiles.id_no_enc`, `companies.iban_enc` | ciphertext: `pgp_sym_encrypt(value, key, 'cipher-algo=aes256')` (pgcrypto, OpenPGP symmetric, AES-256, random session key and salt per value) |
| `profiles.id_no`, `companies.iban` | only a mask, `•••• 1234` |

A `BEFORE INSERT OR UPDATE` trigger (`profiles_encrypt_id`, `companies_encrypt_iban`) does
the work, so every writer (`verify_identity`, `owner_register_company`, seeds, staff tools)
keeps writing a plain value and every reader (apps, portals, `my_private_profile`,
`staff_private_profiles`, `owner_company`) gets the mask without code changes. A mask
written back is ignored. Existing values were encrypted when the migration ran.

The ciphertext columns are not in the `authenticated` column grants, so PostgREST never
returns them; the decrypt helper `pii_decrypt` and the key function are not executable by
`anon` or `authenticated`.

## Who can decrypt

Only these `SECURITY DEFINER` RPCs, each audited (`audit_log`, with the reason):

| RPC | Who | Returns |
|---|---|---|
| `staff_reveal_identity(profile, reason)` | staff roles in `PRIVACY.privileged_roles` (default Super admin, Complaints agent) | ID type and number |
| `staff_reveal_bank(company, reason)` | Finance, Super admin | bank name and IBAN |
| `customer_export(customer)` via `staff_process_data_request` | Super admin, for the customer's own data-access request | the customer's own ID number in their export |

`private.field_key()` reads the key; nothing else does.

## The key

* **Production (Supabase):** the key is a Supabase **Vault** secret named
  `nama_field_key` (32 random bytes, hex). The migration creates it if it is missing
  (`vault.create_secret`). Vault stores it encrypted with a key held by the platform
  (pgsodium / libsodium, outside the database), and exposes it only through
  `vault.decrypted_secrets` to privileged roles. `private.field_key()` reads it there.
* **Local / tests (PGlite, plain Postgres):** no Vault, so the key is generated into
  `private.field_keys`. The `private` schema is not exposed by the API and its table is
  not granted to any API role. This fallback must stay empty in production.

### Rotation

1. Create a new secret, e.g. `nama_field_key_v2`.
2. In one transaction: re-encrypt every value
   (`update profiles set id_no_enc = pgp_sym_encrypt(pgp_sym_decrypt(id_no_enc, old), new, 'cipher-algo=aes256')`, same for `companies.iban_enc`),
   then point `private.field_key()` at the new name.
3. Delete the old secret after a backup cycle.

Rotation is a privileged maintenance migration, not an API action.

### Backups and restores

Database backups contain ciphertext only. A restore needs the Vault secret (Supabase keeps
Vault with the project; a self-hosted Oman deployment must back up its KMS/Vault key
separately and keep it apart from the database backups).

## Go-live (Oman hosting)

When the platform moves to an in-country stack, put the key in the customer's KMS/HSM
(e.g. a Vault or HSM service operated in Oman) and have `private.field_key()` fetch it
from there. The trigger and RPC design does not change.

## Not covered

* Supabase's own disk encryption covers every other column at rest; TLS covers transit.
* Identity-document photos (Storage, batch B's `identity_documents`) are protected by
  Storage policies, not field encryption.
* Phone numbers stay plain (they are login identifiers in Supabase Auth). NWS screens mask
  them for roles outside `PRIVACY.privileged_roles` and offer an audited reveal
  (`staff_reveal_contact`). Job parties (driver ↔ customer) still read the raw `profiles.phone`
  column through RLS; closing that needs the apps to stop selecting it (see the batch A report).
