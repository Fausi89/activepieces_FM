import {
    Action,
    ActionType,
    ActivepiecesError,
    apId,
    Cursor,
    ErrorCode,
    FlowId,
    FlowOperationRequest,
    flowOperations,
    FlowOperationType,
    flowStructureUtil,
    FlowVersion,
    FlowVersionId,
    FlowVersionState,
    isNil,
    LATEST_SCHEMA_VERSION,
    PlatformId,
    ProjectId,
    sanitizeObjectForPostgresql,
    SeekPage,
    Trigger,
    TriggerType,
    UserId,
} from '@activepieces/shared'
import dayjs from 'dayjs'
import { FastifyBaseLogger } from 'fastify'
import { EntityManager } from 'typeorm'
import { buildPaginator } from '../../helper/pagination/build-paginator'
import { paginationHelper } from '../../helper/pagination/pagination-utils'
import { pieceMetadataService } from '../../pieces/piece-metadata-service'
import { projectService } from '../../project/project-service'
import { userService } from '../../user/user-service'
import { sampleDataService } from '../step-run/sample-data.service'
import { FlowVersionEntity } from './flow-version-entity'
import { flowVersionRepoWrapper } from './flow-version-repo-wrapper'
import { flowVersionSideEffects } from './flow-version-side-effects'
import { flowVersionValidationUtil } from './flow-version-validator-util'
export const flowVersionService = (log: FastifyBaseLogger) => ({
    async lockPieceVersions({
        projectId,
        flowVersion,
        entityManager,
    }: LockPieceVersionsParams): Promise<FlowVersion> {
        if (flowVersion.state === FlowVersionState.LOCKED) {
            return flowVersion
        }

        const pieceVersion: Record<string, string> = {}
        const platformId = await projectService.getPlatformId(projectId)
        const steps = flowStructureUtil.getAllSteps(flowVersion.trigger)
        for (const step of steps) {
            const stepTypeIsPiece = [ActionType.PIECE, TriggerType.PIECE].includes(
                step.type,
            )
            if (stepTypeIsPiece) {
                const pieceMetadata = await pieceMetadataService(log).getOrThrow({
                    projectId,
                    platformId,
                    name: step.settings.pieceName,
                    version: step.settings.pieceVersion,
                    entityManager,
                })
                pieceVersion[step.name] = pieceMetadata.version
            }
        }
        return flowStructureUtil.transferFlow(flowVersion, (step) => {
            const clonedStep = JSON.parse(JSON.stringify(step))
            if (pieceVersion[step.name]) {
                clonedStep.settings.pieceVersion = pieceVersion[step.name]
            }
            return clonedStep
        })
    },

    async applyOperation({
        flowVersion,
        projectId,
        userId,
        userOperation,
        entityManager,
        platformId,
    }: ApplyOperationParams): Promise<FlowVersion> {
        let operations: FlowOperationRequest[] = []
        let mutatedFlowVersion: FlowVersion = flowVersion

        switch (userOperation.type) {
            case FlowOperationType.USE_AS_DRAFT: {
                const previousVersion = await flowVersionService(log).getFlowVersionOrThrow({
                    flowId: flowVersion.flowId,
                    versionId: userOperation.request.versionId,
                    removeConnectionsName: false,
                })
                operations = [{
                    type: FlowOperationType.IMPORT_FLOW,
                    request: {
                        trigger: previousVersion.trigger,
                        displayName: previousVersion.displayName,
                        schemaVersion: previousVersion.schemaVersion,
                    },
                }]
                break
            }
            case FlowOperationType.SAVE_SAMPLE_DATA: {
                const modifiedStep = await sampleDataService(log).modifyStep({
                    projectId,
                    flowVersionId: mutatedFlowVersion.id,
                    stepName: userOperation.request.stepName,
                    payload: userOperation.request.payload,
                    type: userOperation.request.type,
                })
                if (flowStructureUtil.isAction(modifiedStep.type)) {
                    operations = [{
                        type: FlowOperationType.UPDATE_ACTION,
                        request: modifiedStep as Action,
                    }]
                }
                else {
                    operations = [{
                        type: FlowOperationType.UPDATE_TRIGGER,
                        request: modifiedStep as Trigger,
                    }]
                }
                break
            }
            case FlowOperationType.LOCK_FLOW: {
                mutatedFlowVersion = await this.lockPieceVersions({
                    projectId,
                    flowVersion: mutatedFlowVersion,
                    entityManager,
                })

                operations = [userOperation]
                break
            }
            default: {
                operations = [userOperation]
                break
            }
        }
        for (const operation of operations) {
            mutatedFlowVersion = await applySingleOperation(
                projectId,
                mutatedFlowVersion,
                operation,
                platformId,
                log,
            )
        }

        await flowVersionSideEffects(log).postApplyOperation({
            flowVersion: mutatedFlowVersion,
            operation: userOperation,
        })

        mutatedFlowVersion.updated = dayjs().toISOString()
        if (userId) {
            mutatedFlowVersion.updatedBy = userId
        }
        mutatedFlowVersion.connectionIds = flowStructureUtil.extractConnectionIds(mutatedFlowVersion)
        return flowVersionRepoWrapper.save({
            flowVersion: sanitizeObjectForPostgresql(mutatedFlowVersion),
            entityManager,
        })
    },

    async getOne(id: FlowVersionId): Promise<FlowVersion | null> {
        if (isNil(id)) {
            return null
        }
        return flowVersionRepoWrapper.findOne({
            where: {
                id,
            },
        })
    },

    async exists(id: FlowVersionId): Promise<boolean> {
        return flowVersionRepoWrapper.exists({
            where: {
                id,
            },
        })
    },
    async getLatestVersion(flowId: FlowId, state: FlowVersionState): Promise<FlowVersion | null> {
        return flowVersionRepoWrapper.findOne({
            where: {
                flowId,
                state,
            },
            order: {
                created: 'DESC',
            },
        })
    },

    async getLatestLockedVersionOrThrow(flowId: FlowId): Promise<FlowVersion> {
        return flowVersionRepoWrapper.findOneOrFail({
            where: {
                flowId,
                state: FlowVersionState.LOCKED,
            },
            order: {
                created: 'DESC',
            },
        })
    },
    async getOneOrThrow(id: FlowVersionId): Promise<FlowVersion> {
        const flowVersion = await flowVersionService(log).getOne(id)

        if (isNil(flowVersion)) {
            throw new ActivepiecesError({
                code: ErrorCode.ENTITY_NOT_FOUND,
                params: {
                    entityId: id,
                    entityType: 'FlowVersion',
                },
            })
        }

        return flowVersion
    },
    async list({
        cursorRequest,
        limit,
        flowId,
    }: ListFlowVersionParams): Promise<SeekPage<FlowVersion>> {
        const decodedCursor = paginationHelper.decodeCursor(cursorRequest)
        const paginator = buildPaginator({
            entity: FlowVersionEntity,
            query: {
                limit,
                order: 'DESC',
                afterCursor: decodedCursor.nextCursor,
                beforeCursor: decodedCursor.previousCursor,
            },
        })
        const paginationResult = await paginator.paginate(
            flowVersionRepoWrapper.createQueryBuilder()
                .where({
                    flowId,
                }),
        )
        const promises = paginationResult.data.map(async (flowVersion) => {
            return {
                ...flowVersion,
                updatedByUser: isNil(flowVersion.updatedBy) ? null : await userService.getMetaInformation({
                    id: flowVersion.updatedBy,
                }),
            }
        })
        return paginationHelper.createPage<FlowVersion>(
            await Promise.all(promises),
            paginationResult.cursor,
        )
    },
    async getFlowVersionOrThrow({
        flowId,
        versionId,
        removeConnectionsName = false,
        removeSampleData = false,
        entityManager,
    }: GetFlowVersionOrThrowParams): Promise<FlowVersion> {
        const flowVersion: FlowVersion | null = await flowVersionRepoWrapper.findOne({
            where: {
                flowId,
                id: versionId,
            },
            //This is needed to return draft by default because it is always the latest one
            order: {
                created: 'DESC',
            },
        }, entityManager)

        if (isNil(flowVersion)) {
            throw new ActivepiecesError({
                code: ErrorCode.ENTITY_NOT_FOUND,
                params: {
                    entityId: versionId,
                    entityType: 'FlowVersion',
                    message: `flowId=${flowId}`,
                },
            })
        }

        return this.removeConnectionsAndSampleDataFromFlowVersion(
            flowVersion,
            removeConnectionsName,
            removeSampleData,
        )
    },
    async createEmptyVersion(
        flowId: FlowId,
        request: {
            displayName: string
        },
    ): Promise<FlowVersion> {
        const flowVersion: NewFlowVersion = {
            id: apId(),
            displayName: request.displayName,
            flowId,
            trigger: {
                type: TriggerType.EMPTY,
                name: 'trigger',
                settings: {},
                valid: false,
                displayName: 'Select Trigger',
            },
            schemaVersion: LATEST_SCHEMA_VERSION,
            connectionIds: [],
            valid: false,
            state: FlowVersionState.DRAFT,
        }
        return flowVersionRepoWrapper.save({ flowVersion })
    },
    removeConnectionsAndSampleDataFromFlowVersion(
        flowVersion: FlowVersion,
        removeConnectionNames: boolean,
        removeSampleData: boolean,
    ): FlowVersion {
        return flowStructureUtil.transferFlow(flowVersion, (step) => {
            const clonedStep = JSON.parse(JSON.stringify(step))
            if (removeConnectionNames) {
                clonedStep.settings.input = removeConnectionsFromInput(clonedStep.settings.input)
            }
            if (removeSampleData && !isNil(clonedStep?.settings?.inputUiInfo)) {
                clonedStep.settings.inputUiInfo.sampleDataFileId = undefined
                clonedStep.settings.inputUiInfo.sampleDataInputFileId = undefined
                clonedStep.settings.inputUiInfo.currentSelectedData = undefined
                clonedStep.settings.inputUiInfo.lastTestDate = undefined
            }
            return clonedStep
        })
    },
})



async function applySingleOperation(
    projectId: ProjectId,
    flowVersion: FlowVersion,
    operation: FlowOperationRequest,
    platformId: PlatformId,
    log: FastifyBaseLogger,
): Promise<FlowVersion> {
    await flowVersionSideEffects(log).preApplyOperation({
        projectId,
        flowVersion,
        operation,
    })
    const preparedOperation = await flowVersionValidationUtil(log).prepareRequest(projectId, platformId, operation)
    const updatedFlowVersion = flowOperations.apply(flowVersion, preparedOperation)
    await flowVersionSideEffects(log).postApplyOperation({
        flowVersion: updatedFlowVersion,
        operation: preparedOperation,
    })
    return updatedFlowVersion
}

function removeConnectionsFromInput(
    obj: Record<string, unknown>,
): Record<string, unknown> {
    if (isNil(obj)) {
        return obj
    }
    const replacedObj: Record<string, unknown> = {}

    for (const [key, value] of Object.entries(obj)) {
        if (Array.isArray(value)) {
            replacedObj[key] = value
        }
        else if (typeof value === 'object' && value !== null) {
            replacedObj[key] = removeConnectionsFromInput(value as Record<string, unknown>)
        }
        else if (typeof value === 'string') {
            const replacedValue = value.replace(/\{{connections\.[^}]*}}/g, '')
            replacedObj[key] = replacedValue === '' ? undefined : replacedValue
        }
        else {
            replacedObj[key] = value
        }
    }
    return replacedObj
}

type GetFlowVersionOrThrowParams = {
    flowId: FlowId
    versionId: FlowVersionId | undefined
    removeConnectionsName?: boolean
    removeSampleData?: boolean
    entityManager?: EntityManager
}

type NewFlowVersion = Omit<FlowVersion, 'created' | 'updated'>

type ListFlowVersionParams = {
    flowId: FlowId
    cursorRequest: Cursor | null
    limit: number
}

type ApplyOperationParams = {
    userId: UserId | null
    projectId: ProjectId
    platformId: PlatformId
    flowVersion: FlowVersion
    userOperation: FlowOperationRequest
    entityManager?: EntityManager
}

type LockPieceVersionsParams = {
    projectId: ProjectId
    flowVersion: FlowVersion
    entityManager?: EntityManager
}
