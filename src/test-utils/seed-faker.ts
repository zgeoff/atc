import { faker } from '@faker-js/faker';

// Seeds faker once for the whole run, so a failing run's factory values
// come out the same on the next run.
faker.seed(48);
