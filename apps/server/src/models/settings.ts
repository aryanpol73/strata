import { Schema, model } from 'mongoose';

/** Small server-wide values that have to be shared by every node, such as the generated push keys. */
const settingSchema = new Schema<{ _id: string; value: unknown }>({ _id: String, value: Schema.Types.Mixed }, { versionKey: false });

export const Setting = model('Setting', settingSchema);
