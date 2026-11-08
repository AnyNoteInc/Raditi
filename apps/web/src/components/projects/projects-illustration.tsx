import Box from '@mui/material/Box'

/**
 * The drawing of the empty list of projects (docs/plan/64-cabinet-navigation.md, Н8): two windows
 * of a site and the asterisk of Радити, drawn by hand in the colour of the text.
 */
export function ProjectsIllustration() {
  return (
    <Box
      component="svg"
      width={168}
      height={132}
      viewBox="0 0 168 132"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      sx={{
        color: 'text.primary',
        '& .back': { opacity: 0.45 },
        '& .fill': { fill: 'var(--mui-palette-background-paper)' },
      }}
    >
      <path
        className="back"
        d="M30 22h86a8 8 0 0 1 8 8v52a8 8 0 0 1-8 8H30a8 8 0 0 1-8-8V30a8 8 0 0 1 8-8zM22 36h102"
      />
      <path
        className="fill"
        d="M52 44h88a8 8 0 0 1 8 8v56a8 8 0 0 1-8 8H52a8 8 0 0 1-8-8V52a8 8 0 0 1 8-8z"
      />
      <path d="M44 58h104M58 72h44M58 82h68M58 92h30" />
      <circle cx={54} cy={51} r={1.6} />
      <circle cx={61} cy={51} r={1.6} />
      <circle cx={68} cy={51} r={1.6} />
      <Box
        component="path"
        d="M140 14v20M131.3 19l17.4 10M131.3 29l17.4-10"
        sx={{ stroke: 'var(--mui-palette-primary-main)', strokeWidth: 2.8 }}
      />
      <path className="fill" d="M112 96l14 6-6 2-2 6z" />
    </Box>
  )
}
