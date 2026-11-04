import { z } from 'zod';
import { ServerKitRouter, bodyParserMiddleware, requirePolicy } from '@maroonedsoftware/koa';
import { RuleProposalService } from '#modules/rules/rule.proposal.service.js';
import { RulesService } from '#modules/rules/rules.service.js';
import {
    AcceptRuleProposalRequest,
    CreateRuleRequest,
    DeleteRuleQuery,
    PatchRuleRequest,
    Rule,
    RuleCheckReport,
    RuleCheckRequest,
    RuleProposal,
    RuleRevision,
    RuleRevisionsQuery,
} from '../generated/rules.js';
import { parseAndValidate } from '@maroonedsoftware/zod';

/**
 * generated from [rules.ck](../../data/contracts/rules.ck)
 */
export const RulesRouter = ServerKitRouter();

/**
 * from [rules.ck](../../data/contracts/rules.ck) `GET /api/rules`
 */
RulesRouter.get('/api/rules', requirePolicy({ policy: 'wilson.view' }), async ctx => {
    const service = ctx.container.get(RulesService);
    const result: Rule[] = await service.list();

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [rules.ck](../../data/contracts/rules.ck) `POST /api/rules`
 */
RulesRouter.post('/api/rules', requirePolicy({ policy: 'wilson.step.up' }), bodyParserMiddleware(['json']), async ctx => {
    const body = await parseAndValidate(ctx.parsedBody, CreateRuleRequest);

    const service = ctx.container.get(RulesService);
    const result: Rule = await service.create(body);

    ctx.status = 201;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [rules.ck](../../data/contracts/rules.ck) `GET /api/rules/proposals`
 */
RulesRouter.get('/api/rules/proposals', requirePolicy({ policy: 'wilson.view' }), async ctx => {
    const service = ctx.container.get(RuleProposalService);
    const result: RuleProposal[] = await service.list();

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [rules.ck](../../data/contracts/rules.ck) `POST /api/rules/proposals/{id}/accept`
 */
RulesRouter.post('/api/rules/proposals/:id/accept', requirePolicy({ policy: 'wilson.step.up' }), bodyParserMiddleware(['json']), async ctx => {
    const { id } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            id: z.string(),
        }),
    );

    const body = await parseAndValidate(ctx.parsedBody, AcceptRuleProposalRequest);

    const service = ctx.container.get(RuleProposalService);
    const result: Rule = await service.accept(id, body);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [rules.ck](../../data/contracts/rules.ck) `POST /api/rules/proposals/{id}/decline`
 */
RulesRouter.post('/api/rules/proposals/:id/decline', requirePolicy({ policy: 'wilson.manage' }), async ctx => {
    const { id } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            id: z.string(),
        }),
    );

    const service = ctx.container.get(RuleProposalService);
    await service.decline(id);

    ctx.status = 204;
});

/**
 * from [rules.ck](../../data/contracts/rules.ck) `POST /api/rules/check`
 */
RulesRouter.post('/api/rules/check', requirePolicy({ policy: 'wilson.manage' }), bodyParserMiddleware(['json']), async ctx => {
    const body = await parseAndValidate(ctx.parsedBody, RuleCheckRequest);

    const service = ctx.container.get(RulesService);
    const result: RuleCheckReport = await service.check(body);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [rules.ck](../../data/contracts/rules.ck) `GET /api/rules/revisions`
 */
RulesRouter.get('/api/rules/revisions', requirePolicy({ policy: 'wilson.view' }), async ctx => {
    const query = await parseAndValidate(ctx.query, RuleRevisionsQuery.strict());

    const service = ctx.container.get(RulesService);
    const result: RuleRevision[] = await service.revisions(query);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [rules.ck](../../data/contracts/rules.ck) `PATCH /api/rules/{id}`
 */
RulesRouter.patch('/api/rules/:id', requirePolicy({ policy: 'wilson.step.up' }), bodyParserMiddleware(['json']), async ctx => {
    const { id } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            id: z.string(),
        }),
    );

    const body = await parseAndValidate(ctx.parsedBody, PatchRuleRequest);

    const service = ctx.container.get(RulesService);
    const result: Rule = await service.update(id, body);

    ctx.status = 200;
    ctx.type = 'application/json';
    ctx.body = result;
});

/**
 * from [rules.ck](../../data/contracts/rules.ck) `DELETE /api/rules/{id}`
 */
RulesRouter.delete('/api/rules/:id', requirePolicy({ policy: 'wilson.step.up' }), async ctx => {
    const { id } = await parseAndValidate(
        ctx.params,
        z.strictObject({
            id: z.string(),
        }),
    );

    const query = await parseAndValidate(ctx.query, DeleteRuleQuery.strict());

    const service = ctx.container.get(RulesService);
    await service.remove(id, query);

    ctx.status = 204;
});
