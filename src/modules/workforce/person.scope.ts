import { byColumn, SCOPED_MODELS } from '../../core/scope/scoped-models.js';

/**
 * Data scope of the person registry (P2.01, BACKLOG D-2.01-2). A person has no estate of their own
 * (P3 §8.1): until an employment profile places them (P2.02), the estate that registered them decides who
 * sees them. An estate grant sees that estate's people. Division and section grants see no one yet: they
 * will see the people whose profiles are assigned to them (P2.03). Facility grants see no one.
 *
 * A person with no registering estate is seen only with access to all estates.
 */
SCOPED_MODELS.register('Person', {
  estate: byColumn('registeredEstateId'),
});
