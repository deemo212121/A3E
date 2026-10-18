-- Phase 5: a GENERIC starter chart of accounts, status PROPOSED.
-- It is NOT an approved chart: the Firm's accountant must review names, codes
-- and structure (docs/accounting/COA-TEMPLATE-PROPOSED.md). Tax-related
-- accounts are placeholders for recording only; no tax computation exists.
-- The engine is data-driven and works with any chart the accountant approves.

insert into public.coa_templates (code, name, status, notes) values
  ('PH-SME-V0', 'Generic Philippine SME chart (starter)', 'proposed',
   'Pending accountant review. Do not treat as an approved or BIR-prescribed chart.');

insert into public.coa_template_accounts
  (template_code, code, name, account_type, normal_balance, parent_code, is_postable, sort_order) values
  ('PH-SME-V0', '1000', 'Assets',                              'asset',     'debit',  null,   false, 10),
  ('PH-SME-V0', '1010', 'Cash on Hand',                        'asset',     'debit',  '1000', true,  20),
  ('PH-SME-V0', '1020', 'Cash in Bank',                        'asset',     'debit',  '1000', true,  30),
  ('PH-SME-V0', '1100', 'Accounts Receivable',                 'asset',     'debit',  '1000', true,  40),
  ('PH-SME-V0', '1110', 'Allowance for Doubtful Accounts',     'asset',     'credit', '1000', true,  50),
  ('PH-SME-V0', '1200', 'Inventory',                           'asset',     'debit',  '1000', true,  60),
  ('PH-SME-V0', '1300', 'Prepaid Expenses',                    'asset',     'debit',  '1000', true,  70),
  ('PH-SME-V0', '1310', 'Input Tax (placeholder)',             'asset',     'debit',  '1000', true,  80),
  ('PH-SME-V0', '1320', 'Creditable Withholding Tax (placeholder)', 'asset', 'debit', '1000', true,  90),
  ('PH-SME-V0', '1500', 'Property and Equipment',              'asset',     'debit',  '1000', true, 100),
  ('PH-SME-V0', '1510', 'Accumulated Depreciation',            'asset',     'credit', '1000', true, 110),
  ('PH-SME-V0', '2000', 'Liabilities',                         'liability', 'credit', null,   false, 200),
  ('PH-SME-V0', '2010', 'Accounts Payable',                    'liability', 'credit', '2000', true, 210),
  ('PH-SME-V0', '2020', 'Accrued Expenses',                    'liability', 'credit', '2000', true, 220),
  ('PH-SME-V0', '2100', 'Output Tax (placeholder)',            'liability', 'credit', '2000', true, 230),
  ('PH-SME-V0', '2110', 'Withholding Taxes Payable (placeholder)', 'liability', 'credit', '2000', true, 240),
  ('PH-SME-V0', '2200', 'Loans Payable',                       'liability', 'credit', '2000', true, 250),
  ('PH-SME-V0', '3000', 'Equity',                              'equity',    'credit', null,   false, 300),
  ('PH-SME-V0', '3010', 'Capital',                             'equity',    'credit', '3000', true, 310),
  ('PH-SME-V0', '3020', 'Drawings',                            'equity',    'debit',  '3000', true, 320),
  ('PH-SME-V0', '3100', 'Retained Earnings',                   'equity',    'credit', '3000', true, 330),
  ('PH-SME-V0', '4000', 'Revenue',                             'revenue',   'credit', null,   false, 400),
  ('PH-SME-V0', '4010', 'Sales',                               'revenue',   'credit', '4000', true, 410),
  ('PH-SME-V0', '4020', 'Service Revenue',                     'revenue',   'credit', '4000', true, 420),
  ('PH-SME-V0', '4030', 'Sales Returns and Allowances',        'revenue',   'debit',  '4000', true, 430),
  ('PH-SME-V0', '4100', 'Other Income',                        'revenue',   'credit', '4000', true, 440),
  ('PH-SME-V0', '5000', 'Cost of Sales',                       'expense',   'debit',  null,   false, 500),
  ('PH-SME-V0', '5010', 'Cost of Goods Sold',                  'expense',   'debit',  '5000', true, 510),
  ('PH-SME-V0', '6000', 'Operating Expenses',                  'expense',   'debit',  null,   false, 600),
  ('PH-SME-V0', '6010', 'Salaries and Wages',                  'expense',   'debit',  '6000', true, 610),
  ('PH-SME-V0', '6020', 'Rent Expense',                        'expense',   'debit',  '6000', true, 620),
  ('PH-SME-V0', '6030', 'Utilities Expense',                   'expense',   'debit',  '6000', true, 630),
  ('PH-SME-V0', '6040', 'Supplies Expense',                    'expense',   'debit',  '6000', true, 640),
  ('PH-SME-V0', '6050', 'Depreciation Expense',                'expense',   'debit',  '6000', true, 650),
  ('PH-SME-V0', '6060', 'Professional Fees',                   'expense',   'debit',  '6000', true, 660),
  ('PH-SME-V0', '6070', 'Bank Charges',                        'expense',   'debit',  '6000', true, 670),
  ('PH-SME-V0', '6900', 'Miscellaneous Expense',               'expense',   'debit',  '6000', true, 680);
