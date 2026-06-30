-- phillumeni seed data — NYC matchbook venues
-- Run this AFTER schema.sql
-- Paste into Supabase SQL Editor and click Run

insert into venues (name, address, neighborhood, city, type, emoji, bg_color, sources, note, is_open, lat, lng, verified) values

('Dante',           '79 MacDougal St',    'West Village',    'NYC', 'Italian Café',   '🕯️', '#2A2824', '{"Matchbook Traveler","Matchbook Directory"}', 'Negroni institution. Beautiful matchbook design.',          true,  40.73020, -74.00040, true),
('Bar Pisellino',   '52 Grove St',        'West Village',    'NYC', 'Italian Bar',    '🫒', '#263226', '{"Oh What a Match","Matchbook Traveler"}',    'Highly sought-after matchbook.',                            true,  40.73220, -74.00300, true),
('Employees Only',  '510 Hudson St',      'West Village',    'NYC', 'Cocktail Bar',   '🍸', '#321E12', '{"Matchbook Traveler"}',                      'Signature art deco design.',                                true,  40.73400, -74.00670, true),
('Minetta Tavern',  '113 MacDougal St',   'West Village',    'NYC', 'Tavern',         '🍷', '#261220', '{"Matchbook Directory"}',                     'Classic red-and-black design.',                             false, 40.72970, -74.00030, true),
('Balthazar',       '80 Spring St',       'SoHo',            'NYC', 'Brasserie',      '🪑', '#322810', '{"Matchbook Traveler","Oh What a Match"}',    'Classic French brasserie matchbook.',                       true,  40.72280, -74.00070, true),
('The Odeon',       '145 W Broadway',     'TriBeCa',         'NYC', 'Brasserie',      '⭐', '#101A10', '{"Oh What a Match"}',                         '80s NYC classic still going strong.',                       true,  40.71720, -74.00940, true),
('The Dead Rabbit',  '30 Water St',        'FiDi',            'NYC', 'Irish Bar',      '🐇', '#101828', '{"Matchbook Traveler","Matchbook Directory"}', 'Award-winning bar matchbook.',                              true,  40.70340, -74.01300, true),
('Bemelmans Bar',   '35 E 76th St',       'Upper East Side', 'NYC', 'Hotel Bar',      '🎨', '#322810', '{"Oh What a Match","Matchbook Traveler"}',    'Illustrated matchbooks — one of the best.',                 false, 40.77330, -73.96320, true),
('Attaboy',         '134 Eldridge St',    'Lower East Side', 'NYC', 'Cocktail Bar',   '🌿', '#102210', '{"Matchbook Directory"}',                     'No menu — community find.',                                 true,  40.71780, -73.99180, true),
('Raoul''s',         '180 Prince St',      'SoHo',            'NYC', 'French Bistro',  '🥐', '#28180A', '{"Oh What a Match","Matchbook Traveler"}',    'Iconic NYC matchbook — a must-have.',                        true,  40.72540, -74.00040, true),
('Temple Bar',      '332 Lafayette St',   'NoHo',            'NYC', 'Cocktail Bar',   '🌙', '#0E0E28', '{"Matchbook Traveler"}',                      'Moody and memorable.',                                      true,  40.72580, -73.99630, true),
('Freemans',        'Freeman Alley',      'Lower East Side', 'NYC', 'Restaurant',     '🦌', '#281A0A', '{"Matchbook Traveler"}',                      'Hidden alley gem.',                                         true,  40.72050, -73.99210, true),
('Fraunces Tavern', '54 Pearl St',        'FiDi',            'NYC', 'Historic Tavern','🏛️', '#1A1810', '{"Matchbook Traveler"}',                      'One of NYC oldest buildings. Check ahead.',                  true,  40.70320, -74.01080, true),
('The Campbell',    '15 Vanderbilt Ave',  'Midtown',         'NYC', 'Cocktail Bar',   '🥂', '#12181A', '{"Matchbook Traveler"}',                      'Grand Central gem.',                                        false, 40.75270, -73.97720, true),
('J.G. Melon',      '1291 3rd Ave',       'Upper East Side', 'NYC', 'Bar & Grill',    '🍔', '#1A2410', '{"Matchbook Traveler"}',                      'Classic UES neighborhood spot.',                            true,  40.76990, -73.95960, true),
('Carnegie Club',   '156 W 56th St',      'Midtown',         'NYC', 'Cigar Bar',      '🚬', '#0A0A12', '{"Matchbook Traveler"}',                      'Great cigar bar matchbook.',                                false, 40.76480, -73.98100, true),
('Strip House',     '13 E 12th St',       'Greenwich Village','NYC','Steakhouse',     '🥩', '#1A0A0A', '{"Matchbook Traveler"}',                      'Risqué red matchbook design.',                              false, 40.73380, -73.99440, true),
('Lure Fishbar',    '142 Mercer St',      'SoHo',            'NYC', 'Seafood',        '🐟', '#0A1820', '{"Matchbook Directory"}',                     'Nautical-themed matchbook design.',                         false, 40.72430, -74.00000, true),
('NoMad Bar',       '10 W 28th St',       'NoMad',           'NYC', 'Hotel Bar',      '🏛️', '#181018', '{"Oh What a Match"}',                         'Elegant hotel bar keepsake.',                               true,  40.74490, -73.98890, true),
('Harry''s Cafe',    '1 Hanover Sq',       'FiDi',            'NYC', 'Bar',            '🥃', '#0A1410', '{"Matchbook Traveler"}',                      'Harry''s Steak on the reverse — great design.',              false, 40.70420, -74.01120, true);
