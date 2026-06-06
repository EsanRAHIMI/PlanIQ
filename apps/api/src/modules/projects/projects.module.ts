import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MODELS, ProjectSchema, FloorSchema, PlacementSchema, PlacementFeedbackSchema } from '../../db/schemas';
import { ProjectsService } from './projects.service';
import { ProjectsController } from './projects.controller';

@Module({
  imports: [MongooseModule.forFeature([
    { name: MODELS.Project, schema: ProjectSchema },
    { name: MODELS.Floor, schema: FloorSchema },
    { name: MODELS.Placement, schema: PlacementSchema },
    { name: MODELS.PlacementFeedback, schema: PlacementFeedbackSchema },
  ])],
  controllers: [ProjectsController],
  providers: [ProjectsService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
