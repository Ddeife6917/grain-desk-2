-- Run this in the Supabase SQL Editor if you've already set up your database.
-- It just adds one column — your existing data is untouched.

alter table prices add column if not exists created_by_email text;
