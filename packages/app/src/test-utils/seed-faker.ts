import { faker } from '@faker-js/faker';

// Seeds faker once for the whole run and fixes the date its relative dates
// count from, so a failing run's factory values, dates included, come out
// the same on the next run.
faker.seed(48);
faker.setDefaultRefDate(new Date('2026-01-01T00:00:00.000Z'));
