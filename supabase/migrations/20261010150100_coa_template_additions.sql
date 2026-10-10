-- Adds accounts seen in the Firm's actual client books (cash disbursement,
-- cash receipts, payroll and petty cash workbooks) to the STARTER template.
-- The template stays PROPOSED: the Firm's accountant must still approve it
-- (docs/accounting/COA-TEMPLATE-PROPOSED.md). Placeholder accounts are for
-- recording only; no tax or contribution computation exists.
--
-- Only affects clients that apply the template from now on. Clients that
-- already have a chart add accounts individually (apply_coa_template refuses
-- to touch an existing chart).

insert into public.coa_template_accounts
  (template_code, code, name, account_type, normal_balance, parent_code, is_postable, sort_order) values
  ('PH-SME-V0', '1015', 'Petty Cash Fund',                              'asset',     'debit',  '1000', true,  25),
  ('PH-SME-V0', '1120', 'Advances to Employees',                        'asset',     'debit',  '1000', true,  45),
  ('PH-SME-V0', '1210', 'Raw Materials',                                'asset',     'debit',  '1000', true,  65),
  ('PH-SME-V0', '2030', 'Salaries and Wages Payable',                   'liability', 'credit', '2000', true, 225),
  ('PH-SME-V0', '2105', 'VAT Payable (placeholder)',                    'liability', 'credit', '2000', true, 235),
  ('PH-SME-V0', '2120', 'SSS Contributions Payable',                    'liability', 'credit', '2000', true, 242),
  ('PH-SME-V0', '2130', 'PhilHealth Contributions Payable',             'liability', 'credit', '2000', true, 243),
  ('PH-SME-V0', '2140', 'Pag-IBIG Contributions Payable',               'liability', 'credit', '2000', true, 244),
  ('PH-SME-V0', '2150', 'SSS Loans Payable (employee deductions)',      'liability', 'credit', '2000', true, 245),
  ('PH-SME-V0', '2160', 'Pag-IBIG Loans Payable (employee deductions)', 'liability', 'credit', '2000', true, 246),
  ('PH-SME-V0', '5020', 'Purchases',                                    'expense',   'debit',  '5000', true, 520),
  ('PH-SME-V0', '6012', 'Employer Contributions (SSS, PhilHealth, Pag-IBIG)', 'expense', 'debit', '6000', true, 612),
  ('PH-SME-V0', '6014', 'Employee Benefits',                            'expense',   'debit',  '6000', true, 614),
  ('PH-SME-V0', '6080', 'Repairs and Maintenance',                      'expense',   'debit',  '6000', true, 671),
  ('PH-SME-V0', '6090', 'Fuel and Oil',                                 'expense',   'debit',  '6000', true, 672),
  ('PH-SME-V0', '6100', 'Transportation and Travel',                    'expense',   'debit',  '6000', true, 673),
  ('PH-SME-V0', '6110', 'Communication Expense',                        'expense',   'debit',  '6000', true, 674),
  ('PH-SME-V0', '6120', 'Taxes and Licenses',                           'expense',   'debit',  '6000', true, 675),
  ('PH-SME-V0', '6130', 'Meals Expense',                                'expense',   'debit',  '6000', true, 676),
  ('PH-SME-V0', '6140', 'Representation Expense',                       'expense',   'debit',  '6000', true, 677);
