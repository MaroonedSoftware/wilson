import {
    OperationNodeTransformer,
    type KyselyPlugin,
    type PluginTransformQueryArgs,
    type PluginTransformResultArgs,
    type PrimitiveValueListNode,
    type QueryResult,
    type RootOperationNode,
    type UnknownRow,
    type ValueNode,
} from 'kysely';
import { DateTime } from 'luxon';
import { KyselyDefaultPlugins } from '@maroonedsoftware/kysely';

const toParameter = (value: unknown): unknown => {
    if (!DateTime.isDateTime(value)) return value;
    if (!value.isValid) throw new Error(`Cannot write an invalid DateTime: ${value.invalidReason}`);
    return value.toISO();
};

class DateTimeParameterTransformer extends OperationNodeTransformer {
    protected override transformValue(node: ValueNode): ValueNode {
        return super.transformValue({ ...node, value: toParameter(node.value) });
    }

    protected override transformPrimitiveValueList(node: PrimitiveValueListNode): PrimitiveValueListNode {
        return super.transformPrimitiveValueList({ ...node, values: node.values.map(toParameter) });
    }
}

/**
 * Sends a Luxon `DateTime` parameter as an ISO string.
 *
 * It has no `toPostgres`, so `pg` would otherwise `JSON.stringify` it, and that string reaches
 * Postgres wrapped in double quotes, which `timestamptz` only accepts because its parser skips
 * punctuation. An invalid `DateTime` throws here rather than reaching the database.
 */
export class DateTimeParameterPlugin implements KyselyPlugin {
    private readonly transformer = new DateTimeParameterTransformer();

    transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
        return this.transformer.transformNode(args.node);
    }

    async transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
        return args.result;
    }
}

/** The plugins every Kysely instance here runs with. */
export const WilsonKyselyPlugins = [...KyselyDefaultPlugins, new DateTimeParameterPlugin()];
