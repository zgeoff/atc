import { faker } from '@faker-js/faker';

// Faker's relative dates count from the current time unless given a fixed reference date,
// so seeding alone won't make a failing run's dates come out the same on the next run.
faker.seed(48);
faker.setDefaultRefDate(new Date('2026-01-01T00:00:00.000Z'));
