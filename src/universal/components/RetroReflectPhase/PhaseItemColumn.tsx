import {PhaseItemColumn_retroPhaseItem} from '__generated__/PhaseItemColumn_retroPhaseItem.graphql'
import memoize from 'micro-memoize'
/**
 * Renders a column for a particular "type" of reflection
 * (e.g. positive or negative) during the Reflect phase of the retro meeting.
 */
import React, {Component} from 'react'
import styled from 'react-emotion'
import {createFragmentContainer, graphql} from 'react-relay'
import getNextSortOrder from 'universal/utils/getNextSortOrder'
import PhaseItemChits from 'universal/components/RetroReflectPhase/PhaseItemChits'
import PhaseItemEditor from 'universal/components/RetroReflectPhase/PhaseItemEditor'
import ReflectionStack from 'universal/components/RetroReflectPhase/ReflectionStack'
import StyledFontAwesome from 'universal/components/StyledFontAwesome'
import withAtmosphere, {
  WithAtmosphereProps
} from 'universal/decorators/withAtmosphere/withAtmosphere'
import SetPhaseFocusMutation from 'universal/mutations/SetPhaseFocusMutation'
import {DECELERATE} from 'universal/styles/animation'
import appTheme from 'universal/styles/theme/appTheme'
import ui from 'universal/styles/ui'
import withMutationProps, {WithMutationProps} from 'universal/utils/relay/withMutationProps'
import {PhaseItemColumn_meeting} from '__generated__/PhaseItemColumn_meeting.graphql'

const ColumnWrapper = styled('div')({
  alignItems: 'center',
  display: 'flex',
  flexDirection: 'column',
  flex: 1,
  maxHeight: '36rem',
  padding: '0 1rem 1rem'
})

const ColumnHighlight = styled('div')(({isFocused}: {isFocused: boolean}) => ({
  background: isFocused && appTheme.palette.mid10a,
  display: 'flex',
  justifyContent: 'center',
  transition: `background 150ms ${DECELERATE}`,
  maxWidth: '26rem',
  height: '100%',
  width: '100%'
}))

const ColumnContent = styled('div')({
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'space-between'
})

const HeaderAndEditor = styled('div')({
  flex: 0.3
})

const TypeDescription = styled('div')({
  fontSize: '1.25rem',
  fontStyle: 'italic',
  fontWeight: 600
})

const FocusArrow = styled(StyledFontAwesome)(({isFocused}: {isFocused: boolean}) => ({
  color: ui.palette.yellow,
  opacity: isFocused ? 1 : 0,
  paddingRight: isFocused ? '0.5rem' : 0,
  transition: `all 150ms ${DECELERATE}`,
  transform: `translateX(${isFocused ? 0 : '-100%'})`
}))

const TypeHeader = styled('div')({
  padding: '0 0 1rem',
  userSelect: 'none',
  width: '100%'
})

interface EditorAndStatusProps {
  isPhaseComplete: boolean
}

const EditorAndStatus = styled('div')(({isPhaseComplete}: EditorAndStatusProps) => ({
  visibility: isPhaseComplete ? 'hidden' : undefined
}))

const ChitSection = styled('div')({
  flex: 0.3
})

interface Props extends WithAtmosphereProps, WithMutationProps {
  idx: number
  meeting: PhaseItemColumn_meeting
  phaseRef: React.RefObject<HTMLDivElement>
  retroPhaseItem: PhaseItemColumn_retroPhaseItem
}

class PhaseItemColumn extends Component<Props> {
  phaseEditorRef = React.createRef<HTMLDivElement>()
  makeColumnStack = memoize(
    (reflectionGroups: PhaseItemColumn_meeting['reflectionGroups'], retroPhaseItemId: string) =>
      reflectionGroups.filter(
        (group) => group.retroPhaseItemId === retroPhaseItemId && group.reflections.length > 0
      )
  )
  makeViewerStack = memoize((columnStack) =>
    columnStack
      .filter((group) => group.reflections[0].isViewerCreator)
      .sort((a, b) => (a.sortOrder > b.sortOrder ? 1 : -1))
      .map((group) => group.reflections[0])
  )

  setColumnFocus = () => {
    const {
      atmosphere,
      meeting,
      retroPhaseItem: {retroPhaseItemId}
    } = this.props
    const {
      meetingId,
      facilitatorUserId,
      localPhase: {phaseId, focusedPhaseItemId},
      localStage: {isComplete}
    } = meeting
    const {viewerId} = atmosphere
    const isFacilitator = viewerId === facilitatorUserId
    if (!isFacilitator || isComplete) return
    const variables = {
      meetingId,
      focusedPhaseItemId: focusedPhaseItemId === retroPhaseItemId ? null : retroPhaseItemId
    }
    SetPhaseFocusMutation(atmosphere, variables, {phaseId})
  }

  nextSortOrder = () => getNextSortOrder(this.props.meeting.reflectionGroups)

  render () {
    const {idx, meeting, phaseRef, retroPhaseItem} = this.props
    const {
      meetingId,
      localPhase: {focusedPhaseItemId},
      localStage: {isComplete},
      reflectionGroups
    } = meeting
    const {editorIds = [], question, retroPhaseItemId} = retroPhaseItem
    const isFocused = focusedPhaseItemId === retroPhaseItemId
    const columnStack = this.makeColumnStack(reflectionGroups, retroPhaseItemId)
    const reflectionStack = this.makeViewerStack(columnStack)
    return (
      <ColumnWrapper>
        <ColumnHighlight isFocused={isFocused}>
          <ColumnContent>
            <HeaderAndEditor>
              <TypeHeader onClick={this.setColumnFocus}>
                <TypeDescription>
                  <FocusArrow name='arrow-right' isFocused={isFocused} />
                  {question}
                </TypeDescription>
              </TypeHeader>
              <EditorAndStatus isPhaseComplete={!!isComplete}>
                <PhaseItemEditor
                  phaseEditorRef={this.phaseEditorRef}
                  meetingId={meetingId}
                  nextSortOrder={this.nextSortOrder}
                  retroPhaseItemId={retroPhaseItemId}
                />
              </EditorAndStatus>
            </HeaderAndEditor>
            <ReflectionStack
              reflectionStack={reflectionStack}
              idx={idx}
              phaseEditorRef={this.phaseEditorRef}
              phaseItemId={retroPhaseItemId}
              phaseRef={phaseRef}
              meetingId={meetingId}
            />
            <ChitSection>
              <PhaseItemChits
                count={columnStack.length - reflectionStack.length}
                editorCount={editorIds ? editorIds.length : 0}
              />
            </ChitSection>
          </ColumnContent>
        </ColumnHighlight>
      </ColumnWrapper>
    )
  }
}

// <PhaseItemHealthBar editorCount={editorIds ? editorIds.length : 0} />

export default createFragmentContainer(
  withAtmosphere(withMutationProps(PhaseItemColumn)),
  graphql`
    fragment PhaseItemColumn_retroPhaseItem on RetroPhaseItem {
      retroPhaseItemId: id
      question
      editorIds
    }

    fragment PhaseItemColumn_meeting on RetrospectiveMeeting {
      facilitatorUserId
      meetingId: id
      localPhase {
        phaseId: id
        phaseType
        ... on ReflectPhase {
          focusedPhaseItemId
        }
      }
      localStage {
        isComplete
      }
      phases {
        id
        phaseType
        stages {
          isComplete
        }
        ... on ReflectPhase {
          focusedPhaseItemId
        }
      }
      reflectionGroups {
        id
        ...ReflectionGroup_reflectionGroup
        retroPhaseItemId
        sortOrder
        reflections {
          ...ReflectionCard_reflection
          content
          id
          isEditing
          isViewerCreator
          sortOrder
        }
      }
    }
  `
)
