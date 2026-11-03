import { Registry } from 'injectkit';
import { AppConfig } from '@maroonedsoftware/appconfig';
import { ServerKitModule } from '@maroonedsoftware/koa';
import { CardBranchDiffSource, DiffSource } from './review.diff.source.js';
import { ReviewService } from './review.service.js';

/** A person's review of a card's branch (`review.ck`). */
export const ReviewModule: ServerKitModule = {
    name: 'Review',
    setup: async (registry: Registry, _: AppConfig) => {
        registry.register(DiffSource).useClass(CardBranchDiffSource).asTransient();
        registry.register(ReviewService).useClass(ReviewService).asTransient();
    },
};
