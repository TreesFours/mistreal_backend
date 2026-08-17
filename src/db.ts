import { Sequelize } from 'sequelize';
import dotenv from 'dotenv';

dotenv.config();

const sequelize = new Sequelize(process.env.DATABASE_URL!, {
    dialect: 'postgres',
    logging: false,
    dialectOptions: {
        ssl: {
            require: true,
            rejectUnauthorized: false
        },
        connectTimeout: 60000 // 60 seconds
    },
    pool: {
        max: 5,
        min: 0,
        acquire: 60000,
        idle: 10000
    }
});

export { sequelize };
