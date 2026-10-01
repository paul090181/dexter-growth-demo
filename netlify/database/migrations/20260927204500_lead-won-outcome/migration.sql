ALTER TABLE retail_customer_leads
  DROP CONSTRAINT IF EXISTS retail_customer_leads_status_check;

ALTER TABLE retail_customer_leads
  ADD CONSTRAINT retail_customer_leads_status_check
  CHECK (status IN ('new','replied','follow-up','closed','won'));
