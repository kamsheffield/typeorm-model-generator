import { DataTypeDefaults } from "typeorm/driver/types/DataTypeDefaults";
import IConnectionOptions from "../IConnectionOptions";
import IGenerationOptions from "../IGenerationOptions";
import { Entity } from "../library";
import AbstractDriver from "./AbstractDriver";
import { readFileSync } from "fs";
import { parsePrismaSchema } from "@loancrate/prisma-schema-parser";
import { JoinColumnOptions, RelationOptions } from "typeorm";
import { JoinTableMultipleColumnsOptions } from "typeorm/decorator/options/JoinTableMultipleColumnsOptions";
import { OnUpdateType } from "typeorm/metadata/types/OnUpdateType";
import { OnDeleteType } from "typeorm/metadata/types/OnDeleteType";
import { boolean } from "yargs";

export default class PrismaDriver extends AbstractDriver {
    public readonly EngineName: string = "Prisma";
    public readonly standardPort: number = 0;
    public readonly standardSchema: string = "prisma";
    public readonly standardUser: string = "";

    public defaultValues: DataTypeDefaults;

    private ast: any;
    private astEntities: any = {};

    public constructor() {
        super();
    }

    public ConnectToServer(
        connectionOptons: IConnectionOptions
    ): Promise<void> {
        return new Promise((resolve, reject) => {
            this.ast = parsePrismaSchema(
                readFileSync(connectionOptons.databaseNames[0], {
                    encoding: "utf8",
                })
            );
            resolve();
        });
    }
    public GetAllTables(
        schemas: string[],
        dbNames: string[]
    ): Promise<Entity[]> {
        return new Promise((resolve, reject) => {
            const ret: Entity[] = [];
            this.ast.declarations.forEach((declaration: any) => {
                if (declaration.kind === "model") {
                    ret.push({
                        columns: [],
                        indices: [],
                        relations: [],
                        relationIds: [],
                        sqlName: declaration.name.value,
                        tscName: declaration.name.value,
                        fileName: declaration.name.value,
                        database: dbNames[0],
                        schema: schemas[0],
                        fileImports: [],
                    });
                    this.astEntities[declaration.name.value] = declaration;
                } else if (declaration.kind === "enum") {
                    ret.push({
                        columns: [],
                        indices: [],
                        relations: [],
                        relationIds: [],
                        sqlName: declaration.name.value,
                        tscName: declaration.name.value,
                        fileName: declaration.name.value,
                        database: dbNames[0],
                        schema: schemas[0],
                        fileImports: [],
                        isEnum: true,
                        enumValues: declaration.members
                            .filter((m: any) => m.kind === "enumValue")
                            .map((m: any) => m.name.value),
                    });
                    this.astEntities[declaration.name.value] = declaration;
                }
            });
            resolve(ret);
        });
    }
    public GetCoulmnsFromEntity(
        entities: Entity[],
        schemas: string[],
        dbNames: string[]
    ): Promise<Entity[]> {
        return new Promise((resolve, reject) => {
            entities.forEach((entity) => {
                if (entity.isEnum) {
                    return;
                }

                const astEntity = this.astEntities[entity.tscName];
                astEntity.members.forEach((member: any) => {
                    if (member.kind === "field") {
                        const name: string = member.name.value;

                        let prismaType: string = "";
                        let isOptional: boolean | undefined = undefined;
                        if (member.type.kind === "typeId") {
                            prismaType = member.type.name.value;
                        } else if (member.type.kind === "optional") {
                            prismaType = member.type.type.name.value;
                            isOptional = true;
                        } else if (member.type.kind === "list") {
                            prismaType = member.type.type.name.value;
                        }

                        let isPrimary = false;
                        let isUnique: boolean | undefined = undefined;
                        let dbType: string | undefined = undefined;
                        let length: number | undefined = undefined;
                        let defaultValue: string | undefined = undefined;
                        let relationOptions: RelationOptions | undefined =
                            undefined;
                        let joinColumnOptions: Required<JoinColumnOptions>[] =
                            [];
                        member.attributes.forEach((attribute: any) => {
                            if (attribute.path.value.includes("id")) {
                                isPrimary = true;
                            }
                            if (attribute.path.value.includes("unique")) {
                                isUnique = true;
                            }

                            // create the unique index if we have a unique field
                            if (isUnique) {
                                const indexName =
                                    entity.tscName +
                                    "_" +
                                    member.name.value +
                                    "_key";
                                const existingIndexes = entity.indices.filter(
                                    (i) => i.name === indexName
                                );
                                if (existingIndexes.length === 0) {
                                    entity.indices.push({
                                        name: indexName,
                                        columns: [member.name.value],
                                        options: {
                                            unique: true,
                                            fulltext: undefined,
                                        },
                                    });
                                }
                            }

                            if (attribute.path.value.includes("db")) {
                                dbType = PrismaDriver.GetTypeORMTypeFromDBType(
                                    attribute.path.value[1]
                                );
                                if (attribute.args.length) {
                                    length = attribute.args[0].value;
                                }
                            }

                            if (attribute.path.value.includes("default")) {
                                if (attribute.args.length) {
                                    let prismaDefault: any | undefined;
                                    if (
                                        attribute.args[0].kind ===
                                        "functionCall"
                                    ) {
                                        prismaDefault =
                                            attribute.args[0].path.value[0];
                                    } else if (
                                        attribute.args[0].kind === "literal"
                                    ) {
                                        prismaDefault = attribute.args[0].value;
                                    } else if (
                                        attribute.args[0].kind === "path"
                                    ) {
                                        prismaDefault =
                                            attribute.args[0].value[0];
                                    }
                                    defaultValue =
                                        PrismaDriver.ReturnDefaultValueFunction(
                                            prismaDefault,
                                            prismaType
                                        );
                                }
                            }

                            if (attribute.path.value.includes("relation")) {
                                let fields: string[] = [];
                                let references: string[] = [];
                                let name: string | undefined = undefined;
                                attribute.args.forEach((arg: any) => {
                                    if (arg.kind === "literal") {
                                        name = arg.value;
                                    } else if (arg.name.value === "fields") {
                                        fields = arg.expression.items.map(
                                            (item: any) => item.value[0]
                                        );
                                    } else if (
                                        arg.name.value === "references"
                                    ) {
                                        references = arg.expression.items.map(
                                            (item: any) => item.value[0]
                                        );
                                    } else if (arg.name.value === "name") {
                                        name = arg.expression.value;
                                    } else if (arg.name.value === "onDelete") {
                                        if (!relationOptions) {
                                            relationOptions = {};
                                        }
                                        let onDeleteType: OnDeleteType;
                                        switch (arg.expression.value[0]) {
                                            case "NoAction":
                                                onDeleteType = "NO ACTION";
                                                break;
                                            case "Restrict":
                                                onDeleteType = "RESTRICT";
                                                break;
                                            case "Cascade":
                                                onDeleteType = "CASCADE";
                                                break;
                                            case "SetNull":
                                                onDeleteType = "SET NULL";
                                                break;
                                            case "SetDefault":
                                                onDeleteType = "DEFAULT";
                                                break;
                                            default:
                                                onDeleteType = "NO ACTION";
                                                break;
                                        }
                                        relationOptions.onDelete = onDeleteType;
                                    } else if (arg.name.value === "onUpdate") {
                                        if (!relationOptions) {
                                            relationOptions = {};
                                        }
                                        let onUpdateType: OnUpdateType;
                                        switch (arg.expression.value[0]) {
                                            case "NoAction":
                                                onUpdateType = "NO ACTION";
                                                break;
                                            case "Restrict":
                                                onUpdateType = "RESTRICT";
                                                break;
                                            case "Cascade":
                                                onUpdateType = "CASCADE";
                                                break;
                                            case "SetNull":
                                                onUpdateType = "SET NULL";
                                                break;
                                            case "SetDefault":
                                                onUpdateType = "DEFAULT";
                                                break;
                                            default:
                                                onUpdateType = "NO ACTION";
                                                break;
                                        }
                                        relationOptions.onUpdate = onUpdateType;
                                    } else {
                                        console.log(
                                            "unknown relation attribute: " +
                                                arg.name.value
                                        );
                                    }
                                });
                                // build join options
                                for (let i = 0; i < fields.length; i++) {
                                    joinColumnOptions.push({
                                        name: fields[i],
                                        referencedColumnName: references[i],
                                    });
                                }
                            }
                        });

                        if (dbType === undefined) {
                            dbType =
                                PrismaDriver.GetTypeORMTypeFromPrismaType(
                                    prismaType
                                );
                        }

                        // check for relation and enum column types
                        let tsType: string =
                            PrismaDriver.GetTypeScriptType(prismaType);
                        let enumType: string | undefined = undefined;
                        let type: string | undefined = undefined;
                        let shouldPushColumn = true;
                        const isSelfReference = tsType === entity.tscName;
                        const otherAstEntity = this.astEntities[tsType];
                        if (otherAstEntity) {
                            if (otherAstEntity.kind === "model") {
                                let relationType:
                                    | "OneToOne"
                                    | "OneToMany"
                                    | "ManyToOne"
                                    | "ManyToMany";
                                let relatedField: string = "";
                                for (const otherMember of otherAstEntity.members) {
                                    if (otherMember.kind === "field") {
                                        let otherTypeName: string = "";
                                        if (
                                            otherMember.type.kind === "typeId"
                                        ) {
                                            otherTypeName =
                                                otherMember.type.name.value;
                                        } else if (
                                            otherMember.type.kind === "optional"
                                        ) {
                                            otherTypeName =
                                                otherMember.type.type.name
                                                    .value;
                                        } else if (
                                            otherMember.type.kind === "list"
                                        ) {
                                            otherTypeName =
                                                otherMember.type.type.name
                                                    .value;
                                        }
                                        if (otherTypeName === entity.tscName) {
                                            if (
                                                isSelfReference &&
                                                member.type.kind === "list"
                                            ) {
                                                relationType = "OneToMany";
                                            } else if (isSelfReference) {
                                                relationType = "ManyToOne";
                                            } else {
                                                if (
                                                    member.type.kind ===
                                                        "list" &&
                                                    otherMember.type.kind ===
                                                        "typeId"
                                                ) {
                                                    relationType = "OneToMany";
                                                } else if (
                                                    member.type.kind ===
                                                        "list" &&
                                                    otherMember.type.kind ===
                                                        "list"
                                                ) {
                                                    relationType = "ManyToMany";
                                                } else if (
                                                    member.type.kind ===
                                                        "typeId" &&
                                                    otherMember.type.kind ===
                                                        "list"
                                                ) {
                                                    relationType = "ManyToOne";
                                                } else {
                                                    relationType = "OneToOne";
                                                }
                                            }

                                            let joinTableOptions:
                                                | JoinTableMultipleColumnsOptions
                                                | undefined = undefined;
                                            if (relationType === "ManyToMany") {
                                                joinTableOptions = {
                                                    name: `${entity.tscName}_${otherAstEntity.name.value}`,
                                                    joinColumns: [
                                                        {
                                                            name: `${entity.tscName}_id`,
                                                            referencedColumnName:
                                                                "id",
                                                        },
                                                    ],
                                                    inverseJoinColumns: [
                                                        {
                                                            name: `${otherAstEntity.name.value}_id`,
                                                            referencedColumnName:
                                                                "id",
                                                        },
                                                    ],
                                                };
                                            }

                                            relatedField =
                                                otherMember.name.value;
                                            entity.relations.push({
                                                relationType: relationType,
                                                relatedTable:
                                                    otherAstEntity.name.value,
                                                relatedField: relatedField,
                                                fieldName: name,
                                                joinColumnOptions:
                                                    joinColumnOptions.length
                                                        ? joinColumnOptions
                                                        : undefined,
                                                joinTableOptions:
                                                    joinTableOptions,
                                                relationOptions:
                                                    relationOptions,
                                            });
                                            shouldPushColumn = false;
                                            break;
                                        }
                                    }
                                }
                            } else if (otherAstEntity.kind === "enum") {
                                type = "enum";
                                enumType = otherAstEntity.name.value;
                                dbType = undefined;
                                if (defaultValue) {
                                    defaultValue = `${enumType}.${(
                                        defaultValue as string
                                    ).toUpperCase()}`;
                                }
                                entity.fileImports.push({
                                    fileName: enumType!,
                                    entityName: enumType!,
                                });
                            }
                        }
                        let generated:
                            | boolean
                            | "increment"
                            | "uuid"
                            | undefined = undefined;
                        if (isPrimary && defaultValue) {
                            generated = true;
                            if (defaultValue === "uuid") {
                                dbType = "uuid";
                            } else {
                                dbType = "int";
                            }
                            defaultValue = undefined;
                            length = undefined;
                        }
                        if (shouldPushColumn) {
                            entity.columns.push({
                                generated: generated,
                                tscName: name,
                                type: dbType,
                                tscType: tsType,
                                default: defaultValue,
                                primary: isPrimary,
                                options: {
                                    name: name,
                                    type: type,
                                    nullable: isOptional,
                                    unique: isUnique,
                                    length: length,
                                    enum: enumType,
                                },
                            });
                        }
                    } else {
                        if (member.kind === "blockAttribute") {
                            if (
                                member.path.value.includes("index") ||
                                member.path.value.includes("unique") ||
                                member.path.value.includes("fulltext")
                            ) {
                                const indexColumns = member.args[0].items.map(
                                    (item: any) => {
                                        return item.value[0];
                                    }
                                );
                                const indexName =
                                    entity.tscName +
                                    "_" +
                                    indexColumns.join("_") +
                                    "_idx";
                                const existingIndexes = entity.indices.filter(
                                    (i) => i.name === indexName
                                );
                                if (existingIndexes.length === 0) {
                                    entity.indices.push({
                                        name: indexName,
                                        columns: indexColumns,
                                        options: {
                                            unique: member.path.value.includes(
                                                "unique"
                                            )
                                                ? true
                                                : undefined,
                                            fulltext:
                                                member.path.value.includes(
                                                    "fulltext"
                                                )
                                                    ? true
                                                    : undefined,
                                        },
                                    });
                                }
                            } else {
                                console.log("not an index");
                            }
                        }
                    }
                });
            });
            resolve(entities);
        });
    }

    public GetIndexesFromEntity(
        entities: Entity[],
        schemas: string[],
        dbNames: string[]
    ): Promise<Entity[]> {
        return new Promise((resolve, reject) => {
            resolve(entities);
        });
    }

    public GetRelations(
        entities: Entity[],
        schemas: string[],
        dbNames: string[],
        generationOptions: IGenerationOptions
    ): Promise<Entity[]> {
        return new Promise((resolve, reject) => {
            resolve(entities);
        });
    }

    public DisconnectFromServer(): Promise<void> {
        return new Promise((resolve, reject) => {
            resolve();
        });
    }

    public CreateDB(dbName: string): Promise<void> {
        throw new Error("Method not implemented.");
    }

    public DropDB(dbName: string): Promise<void> {
        throw new Error("Method not implemented.");
    }

    public CheckIfDBExists(dbName: string): Promise<boolean> {
        throw new Error("Method not implemented.");
    }

    static GetTypeORMTypeFromPrismaType(type: string): string {
        switch (type) {
            case "String":
                return "varchar";
            case "Int":
                return "int";
            case "Boolean":
                return "boolean";
            case "DateTime":
                return "datetime";
            case "Json":
                return "json";
            default:
                return type; // Prisma uses the object name as the table name.
        }
    }

    static GetTypeORMTypeFromDBType(type: string): string {
        switch (type) {
            case "VarChar":
                return "varchar";
            case "Text":
                return "text";
            case "Int":
                return "int";
            default:
                return type; // Prisma uses the object name as the table name.
        }
    }

    private static GetTypeScriptType(type: string): string {
        switch (type) {
            case "String":
                return "string";
            case "Int":
                return "number";
            case "Boolean":
                return "boolean";
            case "DateTime":
                return "Date";
            case "Json":
                return "object";
            default:
                return type; // it must be an object type so return it as the type.
        }
    }

    private static ReturnDefaultValueFunction(
        prismaDefault: any,
        prismaType: string
    ): any | undefined {
        let defaultValue: any | undefined = undefined;
        if (prismaType === "DateTime") {
            if (prismaDefault === "now") {
                defaultValue = "() => 'CURRENT_TIMESTAMP(3)'";
            }
        } else if (defaultValue === "uuid") {
            defaultValue = "() => 'uuid_generate_v4()'";
        } else {
            defaultValue = prismaDefault;
        }
        return defaultValue;
    }
}
